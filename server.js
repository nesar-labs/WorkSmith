'use strict';

const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const ROOT = __dirname;
const USERS_FILE = path.join(ROOT, 'users.json');
const APPOINTMENTS_FILE = path.join(ROOT, 'appointments.json');
const APPOINTMENT_INBOX = 'nesar.minein@gmail.com';
let firestore = null;
let storageBucket = null;
let firebaseInitError = 'Firebase Admin is not initialized.';
const PORT = Number(process.env.PORT) || 3000;

// Load local development settings without adding a runtime dependency.
async function initializeFirebase() {
  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      firebaseInitError = 'Set FIREBASE_SERVICE_ACCOUNT_JSON in .env to enable Firebase.';
      console.error(firebaseInitError);
      return;
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`;
    const firebaseApp = getApps().length ? getApp() : initializeApp({
      credential: cert(serviceAccount),
      storageBucket: bucketName
    });
    const firestoreDatabaseId = process.env.FIRESTORE_DATABASE_ID || 'nearwise-db';
    firestore = getFirestore(firebaseApp, firestoreDatabaseId);
    storageBucket = getStorage(firebaseApp).bucket(bucketName);
    firebaseInitError = '';
    console.log(`Firebase Admin initialized for Firestore database '${firestoreDatabaseId}' and the configured Storage bucket.`);
  } catch (error) {
    firebaseInitError = error instanceof SyntaxError
      ? 'FIREBASE_SERVICE_ACCOUNT_JSON in .env is not valid JSON.'
      : 'Firebase Admin could not initialize. Check the service account and storage bucket configuration.';
    console.error(firebaseInitError);
  }
}
function requireFirebase(req, res, next) {
  if (!firestore || !storageBucket) return res.status(503).json({ success: false, message: firebaseInitError || 'Firebase is not available.' });
  next();
}
async function saveUserProfile(user, fields = {}) {
  if (!firestore) throw new Error(firebaseInitError || 'Firebase is not available.');
  const document = {
    uid: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    city: user.city || '',
    updatedAt: FieldValue.serverTimestamp(),
    ...fields
  };
  await firestore.collection('users').doc(user.id).set(document, { merge: true });
}


async function loadEnvFile() {
  try {
    const contents = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || Object.hasOwn(process.env, match[1])) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));

let writeQueue = Promise.resolve();

let appointmentWriteQueue = Promise.resolve();
async function readAppointments() {
  try {
    const value = JSON.parse(await fs.readFile(APPOINTMENTS_FILE, 'utf8'));
    const data = Array.isArray(value.appointments) ? value : { appointments: [] };
    if (!Array.isArray(data.notifications)) data.notifications = [];
    if (!Array.isArray(data.messages)) data.messages = [];
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { appointments: [], notifications: [], messages: [] };
    throw error;
  }
}
function addNotification(data, userId, bookingId, type, message, dedupeKey) {
  if (!userId || data.notifications.some(item => item.dedupeKey === dedupeKey)) return null;
  const notification = { id: crypto.randomUUID(), userId: String(userId), bookingId: bookingId ? String(bookingId) : null, type, message: String(message).slice(0, 240), createdAt: new Date().toISOString(), readAt: null, dedupeKey };
  data.notifications.push(notification);
  return notification;
}
function bookingParticipants(appointment, userId) {
  const id = String(userId);
  return { customer: String(appointment.userId) === id, worker: Boolean(appointment.professional?.workerId) && String(appointment.professional.workerId) === id };
}
function updateAppointments(mutator) {
  const operation = appointmentWriteQueue.then(async () => {
    const data = await readAppointments();
    const result = await mutator(data);
    const tempPath = `${APPOINTMENTS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, APPOINTMENTS_FILE);
    return result;
  });
  appointmentWriteQueue = operation.catch(() => {});
  return operation;
}
function createMailer() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) throw new Error('Appointment email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env.');
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function pageHtml(title, message) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} ? WorkSmith</title><body style="margin:0;background:#f4f7fb;font-family:Inter,Arial,sans-serif;color:#0f172a"><main style="max-width:520px;margin:12vh auto;padding:36px 28px;background:#fff;border:1px solid #e2e8f0;border-radius:24px;box-shadow:0 18px 60px #0f172a12;text-align:center"><div style="margin:auto;width:52px;height:52px;border-radius:17px;background:#eff6ff;color:#2563eb;display:grid;place-items:center;font-size:26px">?</div><h1 style="margin:20px 0 8px;font-size:26px">${escapeHtml(title)}</h1><p style="color:#64748b;line-height:1.7">${escapeHtml(message)}</p><a href="/" style="display:inline-block;margin-top:12px;color:#2563eb;font-weight:700;text-decoration:none">Return to WorkSmith</a></main></body></html>`;
}

async function readUsers() {
  try {
    const data = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
    return Array.isArray(data.users) ? data : { users: [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { users: [] };
    throw error;
  }
}
function updateUsers(mutator) {
  const operation = writeQueue.then(async () => {
    const data = await readUsers();
    const result = await mutator(data);
    const tempPath = `${USERS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, USERS_FILE);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function passwordMatches(password, user) {
  if (!user.passwordSalt || !user.passwordHash) return false;
  const { hash } = hashPassword(password, user.passwordSalt);
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

let tokenSecret = crypto.randomBytes(32).toString('hex');
function createToken(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch { return null; }
}
function publicUser(user) {
  const workerProfile = user.workerProfile ? (({ verified, rating, ...profile }) => profile)(user.workerProfile) : null;
  return { id: user.id, name: user.name, email: user.email, phone: user.phone || '', city: user.city, address: user.address || '', profilePhoto: user.profilePhoto || null, role: user.role || 'user', workerProfile, availability: user.availability || {}, ...(user.coords ? { coords: user.coords, locationLabel: user.locationLabel } : {}), createdAt: user.createdAt };
}
function requireAuth(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  const claims = verifyToken(token);
  if (!claims) return res.status(401).json({ success: false, message: 'Please sign in again.' });
  req.auth = claims;
  next();
}

app.get('/api/health', (_req, res) => res.json({ success: true }));

app.post('/api/signup', async (req, res, next) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const normalizedPhone = phone.replace(/[\s().-]/g, '');
    const city = typeof req.body.city === 'string' ? req.body.city.trim() : '';
    const address = typeof req.body.address === 'string' ? req.body.address.trim().slice(0, 300) : '';
    const role = req.body.role === 'worker' ? 'worker' : 'user';
    if (name.length < 2 || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 200 || !/^\+?[1-9]\d{7,14}$/.test(normalizedPhone) || !city) {
      return res.status(400).json({ success: false, message: 'Enter a name, valid email, password of at least 8 characters, valid phone number, and home city.' });
    }
    const user = await updateUsers(data => {
      if (data.users.some(existing => existing.email.toLowerCase() === email)) return null;
      const credentials = hashPassword(password);
      const coords = Array.isArray(req.body.coords) && req.body.coords.length === 2 && req.body.coords.every(Number.isFinite) ? req.body.coords : undefined;
      const created = { id: crypto.randomUUID(), name, email, phone: normalizedPhone, city, address, role, workerProfile: role === 'worker' ? { businessName: '', specialty: '', bio: '', experience: '', serviceLocation: '', rate: 0, rateType: 'hourly', portfolio: [] } : null, availability: {}, ...(coords ? { coords, locationLabel: 'Current GPS location' } : {}), passwordSalt: credentials.salt, passwordHash: credentials.hash, createdAt: new Date().toISOString() };
      data.users.push(created);
      return created;
    });
    if (!user) return res.status(409).json({ success: false, message: 'An account with that email already exists.' });
    try { await saveUserProfile(user, { theme: 'light', palette: 'trust', favorites: [], preferencesVersion: 1, pfpUrl: null, backgroundUrl: null }); }
    catch (firebaseError) { console.error('Could not sync new user profile to Firestore:', firebaseError.message); }
    res.status(201).json({ success: true, user: publicUser(user), token: createToken(user) });
  } catch (error) { next(error); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const data = await readUsers();
    const user = data.users.find(candidate => candidate.email.toLowerCase() === email);
    if (!user || !passwordMatches(password, user)) return res.status(401).json({ success: false, message: 'Email or password is incorrect.' });
    res.json({ success: true, user: publicUser(user), token: createToken(user) });
  } catch (error) { next(error); }
});

app.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    const data = await readUsers();
    const user = data.users.find(candidate => candidate.id === req.auth.sub);
    if (!user) return res.status(401).json({ success: false, message: 'This account is no longer available.' });
    res.json({ success: true, user: publicUser(user) });
  } catch (error) { next(error); }
});

app.patch('/api/me/account-profile', requireAuth, async (req, res, next) => {
  try {
    const user = await updateUsers(data => {
      const record = data.users.find(item => String(item.id) === String(req.auth.sub));
      if (!record) return null;
      const { name, phone, city, address, profilePhoto } = req.body || {};
      if (name !== undefined) {
        if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) throw Object.assign(new Error('Enter a valid name.'), { status: 400 });
        record.name = name.trim();
      }
      if (phone !== undefined) {
        const normalized = typeof phone === 'string' ? phone.trim().replace(/[\s().-]/g, '') : '';
        if (!/^\+?[1-9]\d{7,14}$/.test(normalized)) throw Object.assign(new Error('Enter a valid phone number.'), { status: 400 });
        record.phone = normalized;
      }
      if (city !== undefined) {
        if (typeof city !== 'string' || !city.trim() || city.trim().length > 100) throw Object.assign(new Error('Choose a valid city.'), { status: 400 });
        record.city = city.trim();
        delete record.coords;
        delete record.locationLabel;
      }
      if (address !== undefined) {
        if (typeof address !== 'string' || address.trim().length > 300) throw Object.assign(new Error('Address must be 300 characters or fewer.'), { status: 400 });
        record.address = address.trim();
      }
      if (profilePhoto !== undefined) {
        if (profilePhoto === null || profilePhoto === '') delete record.profilePhoto;
        else if (typeof profilePhoto !== 'string' || profilePhoto.length > 1_500_000 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(profilePhoto)) throw Object.assign(new Error('Choose a PNG, JPEG, or WebP profile photo under 1 MB.'), { status: 400 });
        else record.profilePhoto = profilePhoto;
      }
      record.updatedAt = new Date().toISOString();
      return record;
    });
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
    res.json({ success: true, user: publicUser(user) });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ success: false, message: error.message });
    next(error);
  }
});

app.patch('/api/me/worker-profile', requireAuth, async (req, res, next) => {
  try {
    const result = await updateUsers(data => {
      const user = data.users.find(item => item.id === req.auth.sub);
      if (!user) return null;
      if (user.role !== 'worker') return { forbidden: true };
      const previous = user.workerProfile || {};
      const profile = req.body.profile || {};
      user.workerProfile = {
        businessName: String(profile.businessName ?? previous.businessName ?? '').trim().slice(0, 120),
        specialty: String(profile.specialty || '').trim().slice(0, 100),
        bio: String(profile.bio || '').trim().slice(0, 1000),
        experience: String(profile.experience ?? previous.experience ?? '').trim().slice(0, 500),
        serviceLocation: String(profile.serviceLocation ?? previous.serviceLocation ?? '').trim().slice(0, 300),
        rate: Math.max(0, Math.min(1000000, Number(profile.rate) || 0)),
        rateType: profile.rateType === 'flat' ? 'flat' : 'hourly',
        portfolio: Array.isArray(profile.portfolio) ? profile.portfolio.filter(x => typeof x === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(x)).slice(0, 12) : previous.portfolio || []
      };
      user.availability = req.body.availability && typeof req.body.availability === 'object' ? req.body.availability : user.availability || {};
      return user;
    });
    if (result?.forbidden) return res.status(403).json({ success: false, message: 'Worker access is required to edit this profile.' });
    if (!result) return res.status(404).json({ success: false, message: 'Account not found.' });
    res.json({ success: true, user: publicUser(result) });
  } catch (error) { next(error); }
});

app.get('/api/workers', requireAuth, async (_req, res, next) => {
  try {
    const data = await readUsers();
    const appointments = await readAppointments();
    res.json({ success: true, workers: data.users.filter(user => user.role === 'worker' && user.workerProfile).map(user => ({ id: user.id, name: user.name, profilePhoto: user.profilePhoto || null, city: user.city, phone: user.phone || '', profile: publicUser(user).workerProfile, availability: user.availability || {}, booked: appointments.appointments.filter(a => a.professional?.workerId === user.id && ['pending','confirmed'].includes(String(a.status).toLowerCase())).map(a => ({ date: a.date, time: a.time })) })) });
  } catch (error) { next(error); }
});
app.get('/api/me/appointments', requireAuth, async (req, res, next) => {
  try { const data = await readAppointments(); res.json({ success: true, appointments: data.appointments.filter(item => item.userId === req.auth.sub || item.professional?.workerId === req.auth.sub).map(({ tokenHash, tokenExpiresAt, ...item }) => item) }); }
  catch (error) { next(error); }
});
app.get('/api/me/notifications', requireAuth, async (req, res, next) => {
  try {
    const data = await readAppointments();
    const notifications = data.notifications.filter(item => String(item.userId) === String(req.auth.sub)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(({ dedupeKey, ...item }) => item);
    res.json({ success: true, unreadCount: notifications.filter(item => !item.readAt).length, notifications });
  } catch (error) { next(error); }
});
app.patch('/api/me/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    const result = await updateAppointments(data => {
      const notification = data.notifications.find(item => String(item.id) === String(req.params.id) && String(item.userId) === String(req.auth.sub));
      if (!notification) return null;
      notification.readAt ||= new Date().toISOString();
      return notification;
    });
    if (!result) return res.status(404).json({ success: false, message: 'Notification not found.' });
    res.json({ success: true, notification: { id: result.id, readAt: result.readAt } });
  } catch (error) { next(error); }
});
app.get('/api/bookings/:id/messages', requireAuth, async (req, res, next) => {
  try {
    if (typeof req.params.id !== 'string' || req.params.id.length > 100) return res.status(400).json({ success: false, message: 'Invalid booking ID.' });
    const data = await readAppointments();
    const appointment = data.appointments.find(item => String(item.id) === String(req.params.id));
    if (!appointment) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (!Object.values(bookingParticipants(appointment, req.auth.sub)).some(Boolean)) return res.status(403).json({ success: false, message: 'You are not a participant in this booking.' });
    const users = await readUsers();
    const messages = data.messages.filter(item => String(item.bookingId) === String(appointment.id)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(item => ({ ...item, senderName: users.users.find(user => String(user.id) === String(item.senderId))?.name || (String(item.senderId) === String(appointment.userId) ? appointment.customerName : appointment.professional?.name || 'Professional') }));
    res.json({ success: true, messages });
  } catch (error) { next(error); }
});
app.post('/api/bookings/:id/messages', requireAuth, async (req, res, next) => {
  const messageText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const idempotencyKey = req.get('Idempotency-Key') || '';
  if (!messageText || messageText.length > 2000) return res.status(400).json({ success: false, message: 'Enter a message of 1 to 2,000 characters.' });
  if (idempotencyKey && !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) return res.status(400).json({ success: false, message: 'Invalid message request ID.' });
  try {
    const result = await updateAppointments(async data => {
      if (typeof req.params.id !== 'string' || req.params.id.length > 100) return { error: 'Invalid booking ID.', status: 400 };
      const appointment = data.appointments.find(item => String(item.id) === String(req.params.id));
      if (!appointment) return { error: 'Booking not found.', status: 404 };
      const participants = bookingParticipants(appointment, req.auth.sub);
      if (!participants.customer && !participants.worker) return { error: 'You are not a participant in this booking.', status: 403 };
      if (participants.customer && participants.worker) return { error: 'This booking has invalid participant assignments.', status: 409 };
      if (idempotencyKey) {
        const existing = data.messages.find(item => String(item.bookingId) === String(appointment.id) && String(item.senderId) === String(req.auth.sub) && item.idempotencyKey === idempotencyKey);
        if (existing) return { message: existing, senderName: await readUsers().then(store => store.users.find(user => String(user.id) === String(req.auth.sub))?.name).catch(() => 'A booking participant') };
      }
      if (['rejected', 'cancelled'].includes(String(appointment.status).toLowerCase())) return { error: 'Messaging is closed for this booking.', status: 409 };
      const record = { id: crypto.randomUUID(), bookingId: String(appointment.id), senderId: String(req.auth.sub), text: messageText, createdAt: new Date().toISOString(), ...(idempotencyKey ? { idempotencyKey } : {}) };
      data.messages.push(record);
      const recipientId = participants.customer ? appointment.professional?.workerId : appointment.userId;
      const sender = await readUsers().then(store => store.users.find(user => String(user.id) === String(req.auth.sub))?.name).catch(() => 'A booking participant');
      addNotification(data, recipientId, appointment.id, 'message', `New message about your booking from ${sender || 'a participant'}.`, `message:${record.id}`);
      return { message: record, senderName: sender || (participants.customer ? appointment.customerName : appointment.professional?.name || 'Professional') };
    });
    if (result.error) return res.status(result.status).json({ success: false, message: result.error });
    res.status(201).json({ success: true, message: result });
  } catch (error) { next(error); }
});
app.patch('/api/appointments/:id/status', requireAuth, async (req, res, next) => {
  const status = req.body?.status;
  if (!['Confirmed', 'Rejected', 'Cancelled', 'Completed'].includes(status)) return res.status(400).json({ success: false, message: 'Choose a supported booking status.' });
  try {
    const result = await updateAppointments(data => {
      const appointment = data.appointments.find(item => String(item.id) === String(req.params.id));
      if (!appointment) return { error: 'Booking not found.' };
      const participants = bookingParticipants(appointment, req.auth.sub);
      if (!participants.customer && !participants.worker) return { error: 'You are not a participant in this booking.' };
      if (participants.customer && participants.worker) return { error: 'This booking has invalid participant assignments.' };
      const currentStatus = String(appointment.status || 'pending').toLowerCase();
      const isAllowed = (currentStatus === 'pending' && ((participants.worker && ['Confirmed', 'Rejected'].includes(status)) || (participants.customer && status === 'Cancelled')))
        || (currentStatus === 'confirmed' && ((participants.customer || participants.worker) && status === 'Cancelled' || participants.worker && status === 'Completed'));
      if (!isAllowed) return { error: `Cannot change a ${appointment.status} booking to ${status}.` };
      appointment.status = status;
      appointment.statusUpdatedAt = new Date().toISOString();
      delete appointment.tokenHash;
      delete appointment.tokenExpiresAt;
      const recipientId = participants.customer ? appointment.professional?.workerId : appointment.userId;
      const statusText = status === 'Confirmed' ? 'confirmed' : status === 'Rejected' ? 'rejected' : status === 'Cancelled' ? 'cancelled' : 'marked completed';
      const recipientLabel = participants.customer ? 'the professional' : 'the customer';
      addNotification(data, recipientId, appointment.id, `booking_${status.toLowerCase()}`, `Your booking with ${participants.customer ? appointment.professional?.name : appointment.customerName} was ${statusText} by ${participants.customer ? 'the customer' : 'the professional'}.`, `booking:${appointment.id}:status:${status.toLowerCase()}`);
      return { appointment };
    });
    if (result.error) return res.status(409).json({ success: false, message: result.error });
    res.json({ success: true, appointment: { id: result.appointment.id, status: result.appointment.status, statusUpdatedAt: result.appointment.statusUpdatedAt } });
  } catch (error) {
    console.error('[booking-status] Could not update appointments.json:', {
      id: req.params.id,
      status,
      file: APPOINTMENTS_FILE,
      code: error.code,
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({ success: false, message: 'Could not save the booking status. Check the server log for details.' });
  }
});

app.patch('/api/me/location', requireAuth, async (req, res, next) => {
  try {
    const city = typeof req.body.city === 'string' ? req.body.city.trim() : '';
    const coords = req.body.coords;
    if (!city) return res.status(400).json({ success: false, message: 'A home city is required.' });
    if (coords !== undefined && (!Array.isArray(coords) || coords.length !== 2 || !coords.every(Number.isFinite) || Math.abs(coords[0]) > 90 || Math.abs(coords[1]) > 180)) {
      return res.status(400).json({ success: false, message: 'GPS coordinates are invalid.' });
    }
    const user = await updateUsers(data => {
      const record = data.users.find(candidate => candidate.id === req.auth.sub);
      if (!record) return null;
      record.city = city;
      if (coords) { record.coords = coords; record.locationLabel = 'Current GPS location'; }
      else { delete record.coords; delete record.locationLabel; }
      return record;
    });
    if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
    res.json({ success: true, user: publicUser(user) });
  } catch (error) { next(error); }
});

app.get('/api/me/profile', requireAuth, requireFirebase, async (req, res, next) => {
  try {
    let snapshot = await firestore.collection('users').doc(req.auth.sub).get();
    if (!snapshot.exists) {
      const users = await readUsers();
      const user = users.users.find(item => item.id === req.auth.sub);
      if (!user) return res.status(404).json({ success: false, message: 'Profile not found.' });
      await saveUserProfile(user, { theme: 'light', palette: 'trust', favorites: [], preferencesVersion: 0, pfpUrl: null, backgroundUrl: null });
      snapshot = await firestore.collection('users').doc(req.auth.sub).get();
    }
    const profile = snapshot.data();
    const needsPreferenceMigration = !profile.preferencesVersion;
    res.json({ success: true, profile: { needsPreferenceMigration, uid: profile.uid || req.auth.sub, name: profile.name || '', email: profile.email || '', phone: profile.phone || '', city: profile.city || '', theme: profile.theme || 'light', palette: profile.palette || 'trust', favorites: Array.isArray(profile.favorites) ? profile.favorites : [], pfpUrl: null, backgroundUrl: null } });
  } catch (error) { next(error); }
});

app.patch('/api/me/preferences', requireAuth, requireFirebase, async (req, res, next) => {
  try {
    const allowed = ['light', 'dark', 'theme3'];
    const updates = {};
    if (req.body.theme !== undefined) {
      if (!allowed.includes(req.body.theme)) return res.status(400).json({ success: false, message: 'Theme must be light, dark, or theme3.' });
      updates.theme = req.body.theme;
    }
    if (req.body.palette !== undefined) {
      if (!['trust', 'growth', 'minimalist'].includes(req.body.palette)) return res.status(400).json({ success: false, message: 'Palette must be trust, growth, or minimalist.' });
      updates.palette = req.body.palette;
    }
    if (req.body.favorites !== undefined) {
      if (!Array.isArray(req.body.favorites) || req.body.favorites.length > 100 || req.body.favorites.some(id => typeof id !== 'string' || id.length > 200)) return res.status(400).json({ success: false, message: 'Favorites must be a list of up to 100 valid IDs.' });
      updates.favorites = [...new Set(req.body.favorites)];
    }
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length < 2 || req.body.name.trim().length > 100) return res.status(400).json({ success: false, message: 'Enter a valid profile name.' });
      updates.name = req.body.name.trim();
    }
    if (req.body.phone !== undefined) {
      const phone = typeof req.body.phone === 'string' ? req.body.phone.trim().replace(/[\s().-]/g, '') : '';
      if (!/^\+?[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ success: false, message: 'Enter a valid phone number.' });
      updates.phone = phone;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, message: 'Provide at least one profile preference.' });
    updates.preferencesVersion = 1;
    const responsePreferences = { ...updates };
    updates.updatedAt = FieldValue.serverTimestamp();
    await firestore.collection('users').doc(req.auth.sub).set(updates, { merge: true });
    res.json({ success: true, preferences: responsePreferences });
  } catch (error) { next(error); }
});

app.delete('/api/me/images/:kind', requireAuth, (_req, res) => {
  res.status(410).json({ success: false, message: 'Image storage is disabled. Images are kept in memory for this session only.' });
});

app.post('/api/me/images/:kind', requireAuth, (_req, res) => {
  res.status(410).json({ success: false, message: 'Image storage is disabled. Images are kept in memory for this session only.' });
});

const professionalSearchTerms = {
  Doctor: 'doctor clinic physician medical specialist',
  Engineer: 'engineering consultant civil structural engineer',
  Plumber: 'plumber plumbing service',
  Electrician: 'electrician electrical service',
  Tutor: 'tutor tutoring center coaching classes'
};

function haversineKm(origin, target) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(target.lat - origin.lat);
  const dLng = radians(target.lng - origin.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(origin.lat)) * Math.cos(radians(target.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.post('/api/professionals', requireAuth, async (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ success: false, message: 'Set GOOGLE_MAPS_API_KEY in .env to enable live professional search.' });
  const { category, query = '', city = '', location, radiusMeters = 20000 } = req.body || {};
  const validLocation = location && Number.isFinite(location.lat) && Number.isFinite(location.lng) && Math.abs(location.lat) <= 90 && Math.abs(location.lng) <= 180;
  if (!Object.hasOwn(professionalSearchTerms, category) || typeof city !== 'string' || city.trim().length > 100 || typeof query !== 'string' || query.trim().length > 80 || !validLocation) {
    return res.status(400).json({ success: false, message: 'Choose a supported category and provide a valid search location.' });
  }
  const cleanQuery = query.trim();
  const categoryTerms = professionalSearchTerms[category];
  const textQuery = `${cleanQuery ? `${cleanQuery} ${categoryTerms}` : categoryTerms} near ${city || 'my location'}, India`;
  const safeRadius = Math.min(Math.max(Number(radiusMeters) || 20000, 1000), 50000);
  const radiusKm = safeRadius / 1000;
  const latDelta = radiusKm / 110.574;
  const lngDelta = radiusKm / (111.32 * Math.max(Math.cos(location.lat * Math.PI / 180), 0.01));
  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.types,places.nationalPhoneNumber,places.internationalPhoneNumber,places.rating,places.userRatingCount,places.businessStatus,places.googleMapsUri'
      },
      body: JSON.stringify({
        textQuery,
        pageSize: 15,
        languageCode: 'en',
        regionCode: 'IN',
        includePureServiceAreaBusinesses: true,
        locationRestriction: { rectangle: { low: { latitude: location.lat - latDelta, longitude: location.lng - lngDelta }, high: { latitude: location.lat + latDelta, longitude: location.lng + lngDelta } } }
      })
    });
    const result = await response.json();
    if (!response.ok) return res.status(response.status).json({ success: false, message: result.error?.message || 'Google Places could not search this area.' });
    const professionals = (result.places || []).filter(place => place.location && place.businessStatus !== 'CLOSED_PERMANENTLY').map(place => {
      const coords = { lat: place.location.latitude, lng: place.location.longitude };
      const distanceKm = haversineKm(location, coords);
      return {
        id: place.id,
        placeId: place.id,
        name: place.displayName?.text || 'Local professional',
        category,
        specialty: place.primaryTypeDisplayName?.text || place.primaryType?.replaceAll('_', ' ') || category,
        education: 'Credentials not listed by Google Places',
        phone: place.internationalPhoneNumber || place.nationalPhoneNumber || '',
        address: place.formattedAddress || 'Address not listed',
        coords: [coords.lat, coords.lng],
        rating: place.rating ? Number(place.rating).toFixed(1) : 'New',
        reviews: Number.isFinite(place.userRatingCount) ? Number(place.userRatingCount) : null,
        distance: distanceKm.toFixed(1),
        distanceKm,
        mapsUri: place.googleMapsUri || '',
        verified: Boolean(place.id),
        source: 'google_places',
        available: null
      };
    }).filter(place => place.distanceKm <= radiusKm).sort((a, b) => a.distanceKm - b.distanceKm);
    res.json({ success: true, source: 'google_places', professionals });
  } catch (error) {
    res.status(502).json({ success: false, message: 'Could not reach Google Places. Please try again.' });
  }
});

app.get('/api/providers', requireAuth, requireFirebase, async (req, res, next) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 50) : 20;
    let query = firestore.collection('providers').orderBy('rankScore', 'desc').limit(200);
    const snapshot = await query.get();
    let providers = snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
    if (typeof req.query.category === 'string' && req.query.category.trim()) {
      providers = providers.filter(provider => String(provider.category || '').toLowerCase() === req.query.category.trim().toLowerCase());
    }
    if (typeof req.query.city === 'string' && req.query.city.trim()) {
      providers = providers.filter(provider => String(provider.city || '').toLowerCase() === req.query.city.trim().toLowerCase());
    }
    res.json({ success: true, providers: providers.slice(0, limit) });
  } catch (error) { next(error); }
});

// The browser key is public by design and should be restricted by HTTP referrer in Google Cloud.
app.get('/api/maps-config', (_req, res) => {
  const key = process.env.GOOGLE_MAPS_BROWSER_KEY || '';
  if (!key) return res.status(503).json({ success: false, message: 'Set a referrer-restricted GOOGLE_MAPS_BROWSER_KEY in .env to enable Google Maps.' });
  res.set('Cache-Control', 'no-store').json({ success: true, key });
});

// Appointment requests are stored locally; email delivery and acceptance remain server-side.
app.post('/api/book-appointment', requireAuth, async (req, res) => {
  const { professional, date, time } = req.body || {};
  const serviceAddress = typeof req.body?.serviceAddress === 'string' ? req.body.serviceAddress.trim().slice(0, 500) : '';
  let pendingAppointmentId = null;
  const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && date >= new Date().toISOString().slice(0, 10);
  if (!professional || typeof professional.name !== 'string' || professional.name.length > 160 || typeof professional.category !== 'string' || professional.category.length > 60 || !validDate || typeof time !== 'string' || time.length > 40) {
    return res.status(400).json({ success: false, message: 'Choose a valid professional, date, and time.' });
  }
  try {
    const users = await readUsers();
    const user = users.users.find(candidate => candidate.id === req.auth.sub);
    if (!user) return res.status(401).json({ success: false, message: 'Please sign in again.' });
    const workerId = typeof professional.workerId === 'string' ? professional.workerId : '';
    const worker = workerId ? users.users.find(candidate => candidate.id === workerId && candidate.role === 'worker') : null;
    if (workerId && !worker) return res.status(404).json({ success: false, message: 'This worker is no longer available.' });
      if (worker && String(worker.id) === String(user.id)) return res.status(400).json({ success: false, message: 'You cannot book your own worker profile.' });
    if (worker) {
      const slots = worker.availability?.[date];
      if (!Array.isArray(slots) || !slots.includes(time)) return res.status(409).json({ success: false, message: 'That time is no longer available. Choose another slot.' });
    }
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const appointment = {
      id: crypto.randomUUID(), userId: user.id, customerName: user.name, customerEmail: user.email, customerPhone: user.phone || '',
      professional: { workerId: worker?.id || null, workerEmail: worker?.email || null, name: professional.name, category: professional.category, specialty: String(professional.specialty || professional.category).slice(0, 120), phone: String(professional.phone || '').slice(0, 40), address: String(professional.address || '').slice(0, 300) },
      date, time, city: user.city, serviceAddress: serviceAddress || user.address || user.city || '', createdAt: new Date().toISOString(), status: 'pending', notification: { recipient: worker?.email || APPOINTMENT_INBOX, delivered: false, message: `New booking request from ${user.name} for ${date} at ${time}.`, createdAt: new Date().toISOString() }, tokenHash,
      tokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };
    const saved = await updateAppointments(data => {
      if (workerId && data.appointments.some(item => item.professional?.workerId === workerId && item.date === date && item.time === time && ['pending', 'confirmed'].includes(String(item.status).toLowerCase()))) return false;
      data.appointments.push(appointment);
      if (worker) addNotification(data, worker.id, appointment.id, 'booking_request', `New booking request from ${user.name} for ${date} at ${time}.`, `booking:${appointment.id}:created:${worker.id}`);
      return true;
    });
    if (!saved) return res.status(409).json({ success: false, message: 'That time was just booked. Choose another slot.' });
    pendingAppointmentId = appointment.id;
    const baseUrl = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
    const acceptUrl = `${baseUrl}/api/appointments/accept?token=${encodeURIComponent(rawToken)}`;
    try {
    const mailer = createMailer();
    await mailer.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER, to: worker?.email || APPOINTMENT_INBOX, replyTo: user.email,
      subject: `WorkSmith appointment request: ${appointment.professional.name}`,
      text: `Appointment request from ${user.name} (${user.email}, ${user.phone || 'no phone'}) for ${appointment.professional.name} on ${date} at ${time}. Accept: ${acceptUrl}`,
      html: `<div style="font-family:Inter,Arial,sans-serif;color:#0f172a;max-width:600px;margin:auto;padding:28px"><div style="padding:28px;background:linear-gradient(135deg,#2563eb,#5b21b6);border-radius:20px;color:white"><div style="font-size:12px;letter-spacing:.15em;font-weight:700">WORKSMITH ? BOOKING REQUEST</div><h1 style="font-size:25px;margin:14px 0 0">Appointment request</h1></div><div style="padding:24px 4px;line-height:1.8"><p><b>Customer:</b> ${escapeHtml(user.name)}</p><p><b>Email:</b> ${escapeHtml(user.email)}</p><p><b>Phone:</b> ${escapeHtml(user.phone || 'Not supplied')}</p><p><b>Professional:</b> ${escapeHtml(appointment.professional.name)} ? ${escapeHtml(appointment.professional.specialty)}</p><p><b>Requested time:</b> ${escapeHtml(date)} at ${escapeHtml(time)}</p><p><b>Area:</b> ${escapeHtml(user.city)}</p><p style="margin-top:26px"><a href="${escapeHtml(acceptUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:700">Accept appointment</a></p><p style="font-size:12px;color:#64748b">This one-time action link expires in 7 days.</p></div></div>`
    });
    appointment.notification.delivered = true;
    appointment.notification.channel = 'email';
    await updateAppointments(data => { const record=data.appointments.find(item=>item.id===appointment.id); if(record)record.notification=appointment.notification; return true; });
    } catch (notificationError) { console.warn('Booking was saved; worker email notification is pending configuration:', notificationError.message); }
    res.status(201).json({ success: true, appointment: { id: appointment.id, status: appointment.status }, message: 'Request sent for acceptance.' });
  } catch (error) {
    console.error('Appointment request could not be saved:', error.message);
    res.status(500).json({ success: false, message: 'Could not save the appointment request. Please try again.' });
  }
});

app.get('/api/appointments/accept', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return res.status(400).type('html').send(pageHtml('Invalid link', 'This appointment action link is not valid.'));
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const result = await updateAppointments(data => {
      const match = data.appointments.find(item => item.tokenHash === tokenHash);
      if (!match) return { error: 'This action link has already been used or is invalid.' };
      if (String(match.status).toLowerCase() !== 'pending') return { existing: match };
      if (Date.parse(match.tokenExpiresAt) < Date.now()) return { error: 'This appointment action link has expired.' };
      match.status = 'Confirmed'; match.confirmedAt = new Date().toISOString(); delete match.tokenHash; delete match.tokenExpiresAt;
      addNotification(data, match.userId, match.id, 'booking_confirmed', `Your booking with ${match.professional?.name || 'the professional'} was confirmed.`, `booking:${match.id}:status:confirmed`);
      return { confirmed: match };
    });
    if (result.error) return res.status(410).type('html').send(pageHtml('Link unavailable', result.error));
    const record = result.confirmed || result.existing;
    if (!record) return res.status(404).type('html').send(pageHtml('Request not found', 'This appointment request could not be found.'));
    let confirmationEmailSent = false;
    if (result.confirmed) {
      try {
        const mailer = createMailer();
        await mailer.sendMail({
          from: process.env.EMAIL_FROM || process.env.SMTP_USER, to: record.customerEmail,
          subject: `Appointment confirmed with ${record.professional.name}`,
          text: `Your appointment with ${record.professional.name} on ${record.date} at ${record.time} has been accepted. Contact: ${record.professional.phone || 'Use WorkSmith to contact the professional'}.`,
          html: `<div style="font-family:Inter,Arial,sans-serif;color:#0f172a;max-width:560px;margin:auto;padding:28px"><div style="padding:28px;background:linear-gradient(135deg,#2563eb,#5b21b6);border-radius:20px;color:white"><div style="font-weight:700;letter-spacing:.12em;font-size:12px">WORKSMITH</div><h1 style="margin:14px 0 0">Your appointment is confirmed</h1></div><p style="line-height:1.8;margin-top:24px">Hi ${escapeHtml(record.customerName)},<br>${escapeHtml(record.professional.name)} accepted your request for <b>${escapeHtml(record.date)}</b> at <b>${escapeHtml(record.time)}</b>.</p><p style="color:#64748b">Contact: ${escapeHtml(record.professional.phone || 'Use WorkSmith to contact the professional')}</p></div>`
        });
        confirmationEmailSent = true;
      } catch (mailError) { console.error('Customer confirmation email could not be sent:', mailError.message); }
    }
    const message = result.confirmed ? `Appointment with ${record.professional.name} on ${record.date} at ${record.time} is confirmed. ${confirmationEmailSent ? `A confirmation email has been sent to ${record.customerEmail}.` : 'The confirmation email could not be delivered; please contact the customer directly.'}` : `This appointment with ${record.professional.name} is already confirmed.`;
    return res.status(200).type('html').send(pageHtml(result.confirmed ? 'Appointment accepted' : 'Already accepted', message));
  } catch (error) {
    console.error('Appointment acceptance failed:', error.message);
    res.status(500).type('html').send(pageHtml('Could not accept request', 'Please try again or contact WorkSmith support.'));
  }
});

// Routes API requests stay server-side so the web-service key is never embedded in the page.
app.post('/api/routes', requireAuth, async (req, res) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ success: false, message: 'Set GOOGLE_MAPS_API_KEY in .env to enable live routes.' });
  const { origin, destination } = req.body || {};
  const validPoint = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
  if (!validPoint(origin) || !validPoint(destination)) return res.status(400).json({ success: false, message: 'A valid route origin and destination are required.' });
  try {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline'
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE'
      })
    });
    const result = await response.json();
    if (!response.ok) return res.status(response.status).json({ success: false, message: result.error?.message || 'Google Routes could not calculate this route.' });
    const route = result.routes?.[0];
    if (!route?.polyline?.encodedPolyline) return res.status(404).json({ success: false, message: 'No driving route was found.' });
    res.json({ success: true, route: { encodedPolyline: route.polyline.encodedPolyline, distanceMeters: route.distanceMeters, duration: route.duration } });
  } catch (error) {
    res.status(502).json({ success: false, message: 'Could not reach Google Routes. Please try again.' });
  }
});

// Serve app assets while explicitly shielding local data and configuration files.
app.use((req, res, next) => {
  const requested = decodeURIComponent(req.path);
  const blocked = /^\/(?:\.env(?:\.|$)|users\.json$|appointments\.json$|serviceAccountKey\.json$|nearwise-[^/]+\.json$|server\.js$|node\.js$|package(?:-lock)?\.json$|\.git(?:\/|$))/i;
  if (blocked.test(requested)) return res.sendStatus(404);
  next();
});
app.use(express.static(ROOT, { dotfiles: 'deny', index: 'index.html', setHeaders(res, filePath) {
  if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-cache');
} }));
app.use('/api', (req, res) => res.status(404).json({ success: false, message: `API route not found: ${req.method} ${req.originalUrl}` }));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use((error, _req, res, _next) => {
  console.error('Request failed:', error.message);
  const code = String(error.code || '');
  if (/bucket does not exist/i.test(error.message || '')) return res.status(503).json({ success: false, message: 'Cloud Storage bucket not found. Create a Firebase Storage bucket and set FIREBASE_STORAGE_BUCKET in .env.' });
  if (code === '5' || /NOT_FOUND/.test(code)) return res.status(503).json({ success: false, message: 'Cloud Firestore database not found. Create a Firestore database in this Firebase project, then restart WorkSmith.' });
  if (code === '7' || code === '403' || /PERMISSION_DENIED/.test(code)) return res.status(503).json({ success: false, message: 'Firebase service account lacks Firestore or Storage permissions. Grant the required project access and restart WorkSmith.' });
  res.status(500).json({ success: false, message: 'The server could not complete this request.' });
});

loadEnvFile().then(async () => {
  tokenSecret = process.env.JWT_SECRET || tokenSecret;
  await initializeFirebase();
  app.listen(PORT, () => console.log(`WorkSmith server listening at http://localhost:${PORT}`));
}).catch(error => {
  console.error('Could not load local server configuration:', error.message);
  process.exitCode = 1;
});
