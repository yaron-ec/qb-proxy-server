/* eslint-disable no-undef */
/**
 * ownerResolution — resolve a request owner (id or email) to the canonical
 * owners row. Email is a convenience lookup key; the stable identity is the
 * UUID. If an email is supplied with no existing owner, a new owner row is
 * created (email changes later update owners.email, not the UUID).
 *
 * Pool-based (autonomous) variant for read/availability routes. The booking
 * transaction uses a client-scoped variant inside bookingService.js so owner
 * creation rolls back if the booking fails.
 */
'use strict';

const { query } = require('../../db/client');

async function resolveOwner({ owner_id, owner_email, owner_display_name }) {
  if (owner_id) {
    const r = await query('SELECT * FROM owners WHERE id = $1', [owner_id]);
    if (r.rows[0]) return r.rows[0];
  }
  if (owner_email) {
    const email = String(owner_email).trim().toLowerCase();
    const r = await query('SELECT * FROM owners WHERE lower(email) = lower($1)', [email]);
    if (r.rows[0]) return r.rows[0];
    const ins = await query(
      'INSERT INTO owners (email, display_name) VALUES ($1, $2) RETURNING *',
      [email, owner_display_name || null]
    );
    return ins.rows[0];
  }
  const err = new Error('owner_id or owner_email is required');
  err.status = 400;
  throw err;
}

module.exports = { resolveOwner };