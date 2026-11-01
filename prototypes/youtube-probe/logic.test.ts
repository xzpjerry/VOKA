import { describe, expect, it } from 'vitest';
import {
  attributeMediaEvent,
  classifyTracks,
  hoverOutcome,
  parseCueBody,
  shouldResumeAfterHover,
} from './logic';

describe('YouTube probe measurement logic', () => {
  it('classifies human English, automatic English, other-language-only and no-caption tracks', () => {
    expect(classifyTracks([{ languageCode: 'en' }])).toBe('humanEnglish');
    expect(classifyTracks([{ languageCode: 'en-US', kind: 'asr' }])).toBe('autoEnglishOnly');
    expect(classifyTracks([{ languageCode: 'ja', kind: 'asr' }])).toBe('otherLanguageOnly');
    expect(classifyTracks([])).toBe('noCaptions');
  });

  it('parses synthetic JSON3 cues and recognizes word-offset timing for automatic captions', () => {
    const body = JSON.stringify({
      events: [{
        tStartMs: 1000,
        dDurationMs: 1200,
        segs: [
          { utf8: 'hello', tOffsetMs: 0 },
          { utf8: ' world', tOffsetMs: 500 },
        ],
      }],
    });
    const result = parseCueBody(body, true);
    expect(result.nonEmpty).toBe(true);
    expect(result.cueCount).toBe(1);
    expect(result.cuesHaveStartAndDuration).toBe(true);
    expect(result.autoWordLevelTiming).toBe(true);
    expect(result.cues[0]).toMatchObject({ start: 1, duration: 1.2 });
  });

  it('parses synthetic VTT and XML cue timings without treating the body as a stored measurement', () => {
    const vtt = parseCueBody('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nfixture line', false);
    expect(vtt.cueCount).toBe(1);
    expect(vtt.cuesHaveStartAndDuration).toBe(true);
    expect(vtt.autoWordLevelTiming).toBeNull();

    const xml = parseCueBody('<transcript><text start="0.5" dur="1.25">fixture line</text></transcript>', true);
    expect(xml.cueCount).toBe(1);
    expect(xml.cuesHaveStartAndDuration).toBe(true);
    expect(xml.autoWordLevelTiming).toBe(false);
  });

  it('attributes flagged extension actions to VOKA and outside actions to the user', () => {
    expect(attributeMediaEvent('selfTestPause')).toBe('voka');
    expect(attributeMediaEvent('overlayResume')).toBe('voka');
    expect(attributeMediaEvent(null)).toBe('user');
  });

  it('only resumes a hover-paused video when no user event occurred in between', () => {
    expect(shouldResumeAfterHover({ pausedByBox: true, videoIsPaused: true, userEpochAtPause: 3, currentUserEpoch: 3 })).toBe(true);
    expect(shouldResumeAfterHover({ pausedByBox: true, videoIsPaused: true, userEpochAtPause: 3, currentUserEpoch: 4 })).toBe(false);
    expect(shouldResumeAfterHover({ pausedByBox: false, videoIsPaused: true, userEpochAtPause: 3, currentUserEpoch: 3 })).toBe(false);
    expect(shouldResumeAfterHover({ pausedByBox: true, videoIsPaused: false, userEpochAtPause: 3, currentUserEpoch: 3 })).toBe(false);
    expect(hoverOutcome({ wasPlaying: true, pausedByBox: true, resumed: false, userChangedState: true })).toBe('keptPausedAfterUserAction');
    expect(hoverOutcome({ wasPlaying: true, pausedByBox: true, resumed: true, userChangedState: false })).toBe('resumed');
  });
});
