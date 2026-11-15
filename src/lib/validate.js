import { bad } from './http.js';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9][0-9 ()-]{6,18}$/;

/** Collects field errors, then throws one 422. Usage: const f = fields(); f.str(...); f.done(). */
export function fields() {
  const errors = {};
  const api = {
    errors,
    str(body, key, { min = 1, max = 500, optional = false, label } = {}) {
      let v = body[key];
      if (v == null || v === '') { if (!optional) errors[key] = `${label || key} is required.`; return optional ? null : ''; }
      if (typeof v !== 'string') { errors[key] = `${label || key} must be text.`; return ''; }
      v = v.trim();
      if (v.length < min) errors[key] = `${label || key} is too short.`;
      else if (v.length > max) errors[key] = `${label || key} is too long.`;
      return v;
    },
    email(body, key = 'email') {
      const v = String(body[key] ?? '').trim().toLowerCase();
      if (!EMAIL.test(v)) errors[key] = 'Enter a valid email address.';
      return v;
    },
    phone(body, key = 'phone', optional = false) {
      const v = String(body[key] ?? '').trim();
      if (!v && optional) return null;
      if (!PHONE.test(v)) errors[key] = 'Enter a valid phone number.';
      return v.replace(/[ ()-]/g, '');
    },
    password(body, key = 'password') {
      const v = String(body[key] ?? '');
      if (v.length < 10) errors[key] = 'Use at least 10 characters.';
      else if (v.length > 200) errors[key] = 'Password is too long.';
      else if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) errors[key] = 'Include letters and numbers.';
      return v;
    },
    int(body, key, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false, label } = {}) {
      const v = body[key];
      if (v == null || v === '') { if (!optional) errors[key] = `${label || key} is required.`; return null; }
      if (!Number.isInteger(v) || v < min || v > max) { errors[key] = `${label || key} must be a whole number between ${min} and ${max}.`; return null; }
      return v;
    },
    oneOf(body, key, values, { optional = false, label } = {}) {
      const v = body[key];
      if (v == null || v === '') { if (!optional) errors[key] = `${label || key} is required.`; return null; }
      if (!values.includes(v)) errors[key] = `${label || key} is not valid.`;
      return v;
    },
    bool(body, key, { mustBeTrue = false, label } = {}) {
      const v = body[key] === true;
      if (mustBeTrue && !v) errors[key] = `${label || key} is required.`;
      return v;
    },
    done() { if (Object.keys(errors).length) throw bad(undefined, errors); },
  };
  return api;
}

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
export const safeJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
export const isHttpUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; } };
