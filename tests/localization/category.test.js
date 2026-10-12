// The UTILITY floor (shared/localization/category.js): the one list of use cases that may be treated as
// UTILITY, and the function every other module applies. Pure: no database, no network.
jest.mock('../../utils/whatsapp', () => ({ waPost: jest.fn(async () => { throw new Error('the real WhatsApp client must never be used in tests'); }) }));

const { TRANSACTIONAL_USE_CASES, isTransactionalUseCase, floorCategory } = require('../../shared/localization/category');
const planner = require('../../shared/localization/campaignPlanner');

const ALL_USE_CASES = require('../../models/LocalizedTemplate').schema.path('useCase').enumValues;
const TRANSACTIONAL = ['payment_reminder', 'booking_confirmation', 'booking_reminder', 'order_confirmation'];
const NON_TRANSACTIONAL = ALL_USE_CASES.filter((u) => !TRANSACTIONAL.includes(u));

describe('the UTILITY floor list', () => {
  test('exactly the four transactional use cases, and it cannot be edited at run time', () => {
    expect([...TRANSACTIONAL_USE_CASES].sort()).toEqual([...TRANSACTIONAL].sort());
    expect(Object.isFrozen(TRANSACTIONAL_USE_CASES)).toBe(true);
    expect(() => { TRANSACTIONAL_USE_CASES.push('promotion'); }).toThrow();
  });

  test('every use case the model knows is classified, and the marketing-style ones (incl. the consent request) are not transactional', () => {
    expect(TRANSACTIONAL.every((u) => ALL_USE_CASES.includes(u))).toBe(true);
    expect(NON_TRANSACTIONAL.sort()).toEqual(
      ['comeback', 'custom', 'greeting', 'loyalty_reminder', 'points_balance', 'points_expiring', 'promotion', 'referral_invite', 'referral_reward', 'welcome_optin'],
    );
    for (const useCase of NON_TRANSACTIONAL) expect(isTransactionalUseCase(useCase)).toBe(false);
    for (const useCase of TRANSACTIONAL) expect(isTransactionalUseCase(useCase)).toBe(true);
  });

  test.each([[undefined], [null], [''], [' payment_reminder'], ['PAYMENT_REMINDER'], ['payment_reminder '], [42], [{}], [['payment_reminder']], [true], ['no_such_use_case']])(
    'an unknown or malformed use case (%j) is never transactional', (useCase) => {
      expect(isTransactionalUseCase(useCase)).toBe(false);
      expect(floorCategory(useCase, 'UTILITY')).toBe('MARKETING');
    },
  );
});

describe('floorCategory(useCase, requested)', () => {
  test.each(TRANSACTIONAL.flatMap((u) => [[u, 'UTILITY', 'UTILITY'], [u, 'MARKETING', 'MARKETING']]))(
    'transactional %s requested as %s -> %s', (useCase, requested, expected) => {
      expect(floorCategory(useCase, requested)).toBe(expected);
    },
  );

  test.each(NON_TRANSACTIONAL.flatMap((u) => [[u, 'UTILITY'], [u, 'MARKETING']]))('non-transactional %s requested as %s -> MARKETING', (useCase, requested) => {
    expect(floorCategory(useCase, requested)).toBe('MARKETING');
  });

  test.each([[undefined], [null], [''], ['utility'], ['AUTHENTICATION'], [1], [{}]])('an unusable requested category (%j) is MARKETING, even for a transactional use case', (requested) => {
    for (const useCase of TRANSACTIONAL) expect(floorCategory(useCase, requested)).toBe('MARKETING');
  });

  test('the planner\'s effective category agrees with the floor for every use case (no variant reports anything)', () => {
    for (const useCase of ALL_USE_CASES) {
      for (const category of ['UTILITY', 'MARKETING']) {
        expect(planner.effectiveCategory({ useCase, category, variants: [] })).toBe(floorCategory(useCase, category));
      }
    }
  });
});
