import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskRow } from '../lib/mask.ts';

test('configured identifiers are masked without mutating the original', () => {
    const input = { first_name: 'Demo', last_name: 'Customer', ssn: '123-45-6789', email: 'demo@example.com', phone: '5551234567', date_of_birth: '1990-05-17' };
    const original = structuredClone(input);
    const output = maskRow('customers', input);
    assert.deepEqual(input, original);
    assert.equal(output.ssn, '***-**-6789');
    assert.equal(output.email, 'd***@example.com');
    assert.equal(output.last_name, 'C***');
    assert.equal(output.date_of_birth, '1990-01-01');
    assert.equal(output.first_name, 'Demo');
});

test('cards retain configured prefixes and suffixes, but hide CVV', () => {
    const result = maskRow('cards', { card_number: '4111111111111234', cvv: '123', cardholder_name: 'Demo Customer' });
    assert.equal(result.card_number, '4111 **** **** 1234');
    assert.equal(result.cvv, '***');
    assert.equal(result.cardholder_name, 'Demo ***');
});

test('transaction fields and unexpected fields remain: masking is not a schema firewall', () => {
    assert.deepEqual(maskRow('transactions', { amount: 10, memo: 'sensitive text' }), { amount: 10, memo: 'sensitive text' });
    assert.equal(maskRow('customers', { unexpected: 'sensitive text' }).unexpected, 'sensitive text');
});

test('invalid entity fails', () => {
    assert.throws(() => maskRow('not-a-table', {}), /Unknown entity/);
});
