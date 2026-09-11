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
  console.log('addressPipeline.test.js - all tests passed');
}
test();
