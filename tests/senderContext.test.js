// Unit tests for utils/senderContext.js (no database).
const senderContext = require('../utils/senderContext');

describe('senderContext', () => {
  test('no context outside run()', () => {
    expect(senderContext.currentWorkspaceId()).toBeNull();
    expect(senderContext.isPlatformForced()).toBe(false);
    expect(senderContext.current()).toBeNull();
  });

  test('run() carries the workspace id (as a string) through awaits and timers', async () => {
    await senderContext.run({ toString: () => 'ws-1' }, async () => {
      expect(senderContext.currentWorkspaceId()).toBe('ws-1');
      await new Promise((r) => setTimeout(r, 5));
      expect(senderContext.currentWorkspaceId()).toBe('ws-1');
      await Promise.resolve().then(() => expect(senderContext.currentWorkspaceId()).toBe('ws-1'));
    });
    expect(senderContext.currentWorkspaceId()).toBeNull();
  });

  test('nested contexts are independent and concurrent runs do not mix', async () => {
    const seen = [];
    await Promise.all([
      senderContext.run('a', async () => { await new Promise((r) => setTimeout(r, 10)); seen.push(['a', senderContext.currentWorkspaceId()]); }),
      senderContext.run('b', async () => { await new Promise((r) => setTimeout(r, 1)); seen.push(['b', senderContext.currentWorkspaceId()]); }),
    ]);
    expect(seen.sort()).toEqual([['a', 'a'], ['b', 'b']]);
    senderContext.run('outer', () => {
      senderContext.run('inner', () => expect(senderContext.currentWorkspaceId()).toBe('inner'));
      expect(senderContext.currentWorkspaceId()).toBe('outer');
    });
  });

  test('runPlatform() forces the platform sender and hides the workspace id', () => {
    senderContext.run('ws-9', () => {
      senderContext.runPlatform(() => {
        expect(senderContext.isPlatformForced()).toBe(true);
        expect(senderContext.currentWorkspaceId()).toBeNull();
      });
      expect(senderContext.isPlatformForced()).toBe(false);
      expect(senderContext.currentWorkspaceId()).toBe('ws-9');
    });
  });

  test('a falsy workspace id gives a context with no workspace', () => {
    senderContext.run(undefined, () => {
      expect(senderContext.currentWorkspaceId()).toBeNull();
      expect(senderContext.current()).toEqual({ workspaceId: null, platform: false, viaPlatform: false });
    });
  });

  test('enter() sets the context for the rest of the async chain', async () => {
    await (async () => {
      senderContext.enter('ws-enter');
      await new Promise((r) => setTimeout(r, 2));
      expect(senderContext.currentWorkspaceId()).toBe('ws-enter');
    })();
  });

  // An event that arrived on the SHARED number belongs to a customer (settings, language) but is answered from the shared number.
  test('viaPlatformNumber keeps the workspace and marks the work as arrived on the shared number', async () => {
    expect(senderContext.isViaPlatformNumber()).toBe(false);
    await senderContext.run('ws-shared', async () => {
      expect(senderContext.isViaPlatformNumber()).toBe(true);
      expect(senderContext.currentWorkspaceId()).toBe('ws-shared');
      expect(senderContext.isPlatformForced()).toBe(false);
      await new Promise((r) => setTimeout(r, 2));
      expect(senderContext.isViaPlatformNumber()).toBe(true);
    }, { viaPlatformNumber: true });
    senderContext.run('ws-own', () => expect(senderContext.isViaPlatformNumber()).toBe(false)); // the default
    await (async () => {
      senderContext.enter('ws-enter', { viaPlatformNumber: true });
      await new Promise((r) => setTimeout(r, 2));
      expect(senderContext.isViaPlatformNumber()).toBe(true);
      expect(senderContext.currentWorkspaceId()).toBe('ws-enter');
    })();
    senderContext.enter('ws-enter', { viaPlatformNumber: false });
    expect(senderContext.isViaPlatformNumber()).toBe(false);
  });

  test('runLike() opens a context for another workspace that answers the way the work in progress answers', () => {
    senderContext.run('ws-event', () => {
      senderContext.runLike('ws-tapped', () => {
        expect(senderContext.currentWorkspaceId()).toBe('ws-tapped');
        expect(senderContext.isViaPlatformNumber()).toBe(false); // the event came in on the customer's own number
      });
    });
    senderContext.run('ws-event', () => {
      senderContext.runLike('ws-tapped', () => {
        expect(senderContext.currentWorkspaceId()).toBe('ws-tapped');
        expect(senderContext.isViaPlatformNumber()).toBe(true); // the event came in on the shared number: so does the answer
      });
    }, { viaPlatformNumber: true });
    senderContext.runLike('ws-alone', () => { // no work in progress at all
      expect(senderContext.currentWorkspaceId()).toBe('ws-alone');
      expect(senderContext.isViaPlatformNumber()).toBe(false);
    });
    senderContext.runPlatform(() => {
      senderContext.runLike('ws-from-otp', () => expect(senderContext.isViaPlatformNumber()).toBe(true)); // platform work stays on the platform number
    });
  });
});
