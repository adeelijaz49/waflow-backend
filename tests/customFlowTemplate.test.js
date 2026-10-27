'use strict';
// The WhatsApp payload of a custom (promotion / flow) template message, pinned: no network, the sender and axios are stubbed.
//   * a message whose approved text has no {{n}} variable carries NO body component (WhatsApp refuses an empty one);
//   * with variables the body component comes first, each value as text; one quick-reply button per payload, indexed in order.
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn(), delete: jest.fn(), defaults: {} }));
jest.mock('../utils/waTenant', () => ({
  GRAPH_BASE: 'https://graph.facebook.com/v25.0',
  resolveCurrent: jest.fn(async () => ({ phoneId: 'PHONE_1', token: 'TOKEN_1', source: 'platform' })),
  wabaIdOf: jest.fn(async () => 'WABA_1'),
}));
jest.mock('../shared/localization', () => ({ localizeOutbound: (body) => body }));

const axios = require('axios');
const wa = require('../utils/whatsapp');

beforeEach(() => { axios.post.mockReset(); axios.post.mockResolvedValue({ data: { messages: [{ id: 'wamid.X' }] } }); });
const sentBody = () => axios.post.mock.calls[0][1];

describe('sendCustomFlowTemplate', () => {
  test('no variables: no body component at all, buttons still indexed from 0', async () => {
    await wa.sendCustomFlowTemplate('966500000001', 'tpl_no_vars', [], ['promo:p1:opt_in:0', 'promo:p1:opt_out:1']);
    expect(axios.post.mock.calls[0][0]).toBe('https://graph.facebook.com/v25.0/PHONE_1/messages');
    expect(sentBody().template.components.map((c) => c.type)).toEqual(['button', 'button']);
    expect(sentBody().template.components[0]).toEqual({ type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'promo:p1:opt_in:0' }] });
    expect(sentBody().template.components[1].index).toBe('1');
  });

  test('with variables: the body component first, every value as text (numbers included), then the buttons; language defaults to English', async () => {
    await wa.sendCustomFlowTemplate('966500000001', 'tpl_vars', ['Sara', 20, 'Big Sale'], ['msgnode_n1_0']);
    const { template, to, type, messaging_product: product } = sentBody();
    expect([to, type, product]).toEqual(['966500000001', 'template', 'whatsapp']);
    expect(template.name).toBe('tpl_vars');
    expect(template.language).toEqual({ code: 'en' });
    expect(template.components[0]).toEqual({ type: 'body', parameters: [{ type: 'text', text: 'Sara' }, { type: 'text', text: '20' }, { type: 'text', text: 'Big Sale' }] });
    expect(template.components.map((c) => c.type)).toEqual(['body', 'button']);
  });

  test('an explicit language is used; a message with neither variables nor buttons has no components', async () => {
    await wa.sendCustomFlowTemplate('966500000001', 'tpl_ar', [], [], { language: 'ar' });
    expect(sentBody().template.language).toEqual({ code: 'ar' });
    expect(sentBody().template.components).toEqual([]);
  });

  test('the access token goes in the header, never in the body or the URL', async () => {
    await wa.sendCustomFlowTemplate('966500000001', 'tpl', ['x'], []);
    expect(axios.post.mock.calls[0][2].headers.Authorization).toBe('Bearer TOKEN_1');
    expect(JSON.stringify(sentBody()) + axios.post.mock.calls[0][0]).not.toContain('TOKEN_1');
  });
});
