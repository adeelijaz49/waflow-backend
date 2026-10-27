'use strict';
// Unit tests for utils/indexWatch.js: an index that cannot be built (Cosmos DB for MongoDB refuses a unique index on a collection
// that already holds documents) is said loudly in the log, naming the model and where to read what to do. Pure: no database.
const { EventEmitter } = require('events');
const watchIndexes = require('../utils/indexWatch');

const fakeModel = (name) => Object.assign(new EventEmitter(), { modelName: name });

describe('indexWatch', () => {
  let errorSpy;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => errorSpy.mockRestore());

  test('returns the model it was given, so it can wrap a model definition', () => {
    const Model = fakeModel('Thing');
    expect(watchIndexes(Model)).toBe(Model);
    expect(watchIndexes.watchIndexes).toBe(watchIndexes);
  });

  test('a failed index build is logged as an error with the model, the reason and where the instructions are', () => {
    const Model = watchIndexes(fakeModel('ConsentEvent'));
    Model.emit('index', new Error('E11000 cannot create unique index on a non-empty collection'));
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain('[indexes] ConsentEvent');
    expect(line).toContain('E11000 cannot create unique index on a non-empty collection');
    expect(line).toContain('NOT enforced by the database');
    expect(line).toContain('docs/platform-multitenancy-and-optin.md'); // the section the message points to exists (see the doc)
    expect(line).toContain('Data changes and indexes');
  });

  test('a successful build says nothing', () => {
    const Model = watchIndexes(fakeModel('Customer'));
    Model.emit('index');
    Model.emit('index', null);
    Model.emit('index', undefined);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('each failure is reported, per model', () => {
    const a = watchIndexes(fakeModel('Workspace'));
    const b = watchIndexes(fakeModel('CampaignMessage'));
    a.emit('index', new Error('one'));
    b.emit('index', new Error('two'));
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(String(errorSpy.mock.calls[0][0])).toContain('Workspace');
    expect(String(errorSpy.mock.calls[1][0])).toContain('CampaignMessage');
  });

  test('the section the message points to exists in the runbook', () => {
    const fs = require('fs');
    const path = require('path');
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'platform-multitenancy-and-optin.md'), 'utf8');
    expect(doc).toMatch(/^#{1,4}\s+(\d+\.\s*)?Data changes and indexes/m);
  });
});
