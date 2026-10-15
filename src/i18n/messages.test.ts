import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'node' } }));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'en' }] }));

const { aiMessage, scanError, t } = await import('.');

describe('messages', () => {
  it('say in words what stopped AI reading', () => {
    expect(aiMessage(new Error('ai:unreachable:api.example.com'))).toBe(t.aiUnreachable('api.example.com'));
    expect(aiMessage(new Error('ai:unknown-host:api.example.com'))).toBe(t.aiUnknownHost('api.example.com'));
    expect(aiMessage(new Error('ai:offline'))).toBe(t.aiOffline);
    expect(aiMessage(new Error('ai:insecure'))).toBe(t.aiUrlInsecure);
    expect(aiMessage(new Error('ai:not-api'))).toBe(t.aiNotApi);
    expect(aiMessage(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(t.aiTimeout);
    // What a server said is passed on as it said it.
    expect(aiMessage(new Error('ai:server 401 invalid x-api-key'))).toBe(t.aiServer('401 invalid x-api-key'));
  });

  it('say in words what stopped the scanner', () => {
    expect(scanError(new Error('The processor worker stopped responding'))).toBe(t.scanWorkerStopped);
    expect(scanError(new Error('The ocr worker was closed'))).toBe(t.scanWorkerStopped);
    expect(scanError(new Error('The camera produced no video.'))).toBe(t.cameraNoVideo);
    expect(scanError(new Error("Can't make the folder Inbox"))).toBe(t.folderNotMade('Inbox'));
    expect(scanError(new Error('denied'))).toBe(t.writeDenied);
    expect(scanError('something else')).toBe('something else');
  });
});
