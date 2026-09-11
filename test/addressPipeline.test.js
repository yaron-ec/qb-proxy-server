/* eslint-disable no-undef */
'use strict';
const assert = require('assert');
const { detectAndReconstruct, buildAddressFieldMap } = require('../lib/addressPipeline');

function test() {
  // Case 1: Street suffix in City field
  {
    const r = detectAndReconstruct('14572 Fountain Brook', 'Lane, Corona CA', '', '');
    assert.strictEqual(r.malformed, true);
    assert.ok(r.street.includes('Lane'));
    assert.ok(!r.city.toLowerCase().startsWith('lane'));
  }
  // Case 1b: Suffix in city without comma
  {
    const r = detectAndReconstruct('14572 Fountain Brook', 'Lane Corona CA', '', '');
    assert.strictEqual(r.malformed, true);
    assert.ok(r.street.includes('Lane'));
  }
  // Case 2: Normal address
  {
    const r = detectAndReconstruct('12004 W Ayres Ave', 'Los Angeles', 'CA', '90066');
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.street, '12004 W Ayres Ave');
  }
  // Case 3: Full address in Street field
  {
    const r = detectAndReconstruct('12004 W Ayres Ave, Los Angeles, CA 90066', '', '', '');
    assert.strictEqual(r.malformed, true);
    assert.strictEqual(r.state, 'CA');
    assert.strictEqual(r.zip, '90066');
  }
  // Case 4: Empty fields
  {
    const r = detectAndReconstruct('', '', '', '');
    assert.strictEqual(r.malformed, false);
  }
  // buildAddressFieldMap - verified
  {
    const result = {
      status: 'verified', street: '14572 Fountain Brook Ln', city: 'Corona',
      state: 'CA', zip: '92880', verifiedAddress: '14572 Fountain Brook Ln, Corona, CA 92880, USA',
      lat: 33.85, lng: -117.57, placeId: 'ChIJabc', originalStreet: '14572 Fountain Brook',
      originalCity: 'Lane, Corona CA', malformed: true,
    };
    const f = buildAddressFieldMap(result, null);
    assert.strictEqual(f.property_address, '14572 Fountain Brook Ln');
    assert.strictEqual(f.property_geocode_status, 'verified');
    assert.strictEqual(f.original_property_address, '14572 Fountain Brook');
  }
  // buildAddressFieldMap - needs_review preserves raw
  {
    const result = {
      status: 'needs_review', street: '123 Unknown St', city: 'Mystery', state: 'CA', zip: '',
      verifiedAddress: '123 Unknown St, Mystery, CA', lat: 33, lng: -117, placeId: null,
      originalStreet: '123 Unknown St', originalCity: 'Mystery', malformed: false,
    };
    const f = buildAddressFieldMap(result, null);
    assert.strictEqual(f.property_address, '123 Unknown St');
    assert.strictEqual(f.property_geocode_status, 'needs_review');
  }
  // buildAddressFieldMap - don't overwrite existing original
  {
    const result = {
      status: 'verified', street: '456 New St', city: 'LA', state: 'CA', zip: '90001',
      verifiedAddress: '456 New St, LA, CA', lat: 34, lng: -118, placeId: 'x',
      originalStreet: '456 new st', originalCity: 'la', malformed: false,
    };
    const existing = { original_property_address: '456 old raw', original_city: 'old la' };
    const f = buildAddressFieldMap(result, existing);
    assert.strictEqual(f.original_property_address, undefined);
  }
  // Case 5: State embedded in City ("Corona CA" — state appended to city)
  {
    const r = detectAndReconstruct('14572 Fountain Brook Ln', 'Corona CA', '', '');
    // detectAndReconstruct doesn't split state from city — that's handled by
    // gmaps.normalizeAddress → stripStateFromCity downstream. Verify it doesn't
    // false-positive as malformed.
    assert.strictEqual(r.malformed, false);
  }
  // Case 6: Extra commas in street (not 3+ parts, so not malformed by Case 3)
  {
    const r = detectAndReconstruct('14572, Fountain Brook Ln', 'Corona', 'CA', '92880');
    assert.strictEqual(r.malformed, false);
  }
  // Case 7: Missing ZIP — should still work, not marked malformed
  {
    const r = detectAndReconstruct('14572 Fountain Brook Ln', 'Corona', 'CA', '');
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.zip, '');
  }
  // Case 8: Capitalization differences (suffix detection is case-insensitive)
  {
    const r = detectAndReconstruct('14572 Fountain Brook', 'lane, corona ca', '', '');
    assert.strictEqual(r.malformed, true);
    assert.ok(r.street.toLowerCase().includes('lane'));
  }
  // Case 9: Common suffix variants — Avenue, Boulevard, Drive, Court, Place
  {
    const r = detectAndReconstruct('12004 W Ayres', 'Ave, Los Angeles, CA', '', '');
    assert.strictEqual(r.malformed, true);
    assert.ok(r.street.includes('Ave'));
  }
  {
    const r = detectAndReconstruct('123 Main', 'Boulevard, Beverly Hills, CA', '', '');
    assert.strictEqual(r.malformed, true);
    assert.ok(r.street.includes('Boulevard'));
  }
  {
    const r = detectAndReconstruct('456 Oak', 'Drive, Pasadena, CA 91101', '', '');
    assert.strictEqual(r.malformed, true);
    assert.ok(r.street.includes('Drive'));
  }
  // Case 10: Partial but unambiguous (street + city, no state/zip)
  {
    const r = detectAndReconstruct('114 W Mariposa St', 'Altadena', '', '');
    assert.strictEqual(r.malformed, false);
    assert.strictEqual(r.street, '114 W Mariposa St');
    assert.strictEqual(r.city, 'Altadena');
  }
  // Case 11: Duplicated state (state in both city and state field)
  {
    const r = detectAndReconstruct('14572 Fountain Brook Ln', 'Corona, CA', 'CA', '92880');
    // Not malformed by detectAndReconstruct — normalizeAddress handles the
    // duplicate by stripping state from city.
    assert.strictEqual(r.malformed, false);
  }
  console.log('addressPipeline.test.js - all tests passed');
}
test();