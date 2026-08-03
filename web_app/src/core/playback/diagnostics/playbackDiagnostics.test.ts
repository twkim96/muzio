import { afterEach, describe, expect, test } from 'vitest';

import type { PlaybackSource } from '../source/source';
import {
  clearPlaybackDiagnostics,
  exportPlaybackDiagnosticsReport,
  getPlaybackDiagnosticSampleId,
  getPlaybackDiagnosticTransportCorrelationId,
  getPlaybackDiagnostics,
  recordPlaybackDiagnosticMilestone,
  setPlaybackDiagnosticsEnabled,
} from './playbackDiagnostics';

const videoSource: PlaybackSource = {
  kind: 'remote',
  mediaId: 'video-id',
  mediaType: 'video',
  url: '/api/media/video-id#t=45',
  mimeType: 'video/mp4',
  name: 'video.mp4',
  durationSec: 120,
};

afterEach(() => {
  setPlaybackDiagnosticsEnabled(false);
  clearPlaybackDiagnostics();
});

describe('playback diagnostic runs', () => {
  test('keeps the media URL unchanged while creating transport and sample ids', () => {
    setPlaybackDiagnosticsEnabled(true);
    clearPlaybackDiagnostics();
    recordPlaybackDiagnosticMilestone('video_selection', videoSource, 45);

    expect(videoSource.url).toBe('/api/media/video-id#t=45');
    expect(getPlaybackDiagnosticTransportCorrelationId()).toMatch(
      /^[a-f0-9]{32}$/,
    );
    expect(getPlaybackDiagnosticSampleId()).toMatch(/^[a-f0-9]{32}$/);
  });

  test('does not create diagnostic identifiers while diagnostics are disabled', () => {
    setPlaybackDiagnosticsEnabled(false);
    expect(getPlaybackDiagnosticTransportCorrelationId()).toBeNull();
    expect(getPlaybackDiagnosticSampleId()).toBeNull();
  });

  test('exports wall-clock correlation metadata and bounded entries', () => {
    setPlaybackDiagnosticsEnabled(true);
    clearPlaybackDiagnostics();
    recordPlaybackDiagnosticMilestone('video_selection', videoSource, 45);

    const [entry] = getPlaybackDiagnostics();
    const report = JSON.parse(exportPlaybackDiagnosticsReport()) as {
      transportCorrelationId: string;
      sampleId: string;
      startedWallClockMs: number;
      browserSurface: string;
      entries: unknown[];
    };

    expect(entry).toMatchObject({
      kind: 'video_selection',
      mediaId: 'video-id',
      targetPositionSec: 45,
      transportCorrelationId: report.transportCorrelationId,
      sampleId: report.sampleId,
    });
    expect(entry?.wallClockMs).toBeGreaterThanOrEqual(report.startedWallClockMs);
    expect(report.browserSurface).toMatch(/^(browser-tab|home-screen-pwa)$/);
    expect(report.entries).toHaveLength(1);
  });

  test('clear starts a new sample without changing the transport correlation', () => {
    setPlaybackDiagnosticsEnabled(true);
    const transport = getPlaybackDiagnosticTransportCorrelationId();
    const first = getPlaybackDiagnosticSampleId();
    clearPlaybackDiagnostics();
    const second = getPlaybackDiagnosticSampleId();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(getPlaybackDiagnosticTransportCorrelationId()).toBe(transport);
  });

  test('preserves the completed run for export and starts enabled runs cleanly', () => {
    setPlaybackDiagnosticsEnabled(true);
    recordPlaybackDiagnosticMilestone('video_selection', videoSource, 45);
    const firstTransport = getPlaybackDiagnosticTransportCorrelationId();
    const firstSample = getPlaybackDiagnosticSampleId();

    setPlaybackDiagnosticsEnabled(false);
    const completedReport = JSON.parse(exportPlaybackDiagnosticsReport()) as {
      transportCorrelationId: string;
      sampleId: string;
      entries: unknown[];
    };
    expect(completedReport.transportCorrelationId).toBe(firstTransport);
    expect(completedReport.sampleId).toBe(firstSample);
    expect(completedReport.entries).toHaveLength(1);

    setPlaybackDiagnosticsEnabled(true);
    const nextTransport = getPlaybackDiagnosticTransportCorrelationId();
    const nextSample = getPlaybackDiagnosticSampleId();
    expect(nextTransport).not.toBe(firstTransport);
    expect(nextSample).not.toBe(firstSample);
    expect(getPlaybackDiagnostics()).toEqual([]);
  });
});
