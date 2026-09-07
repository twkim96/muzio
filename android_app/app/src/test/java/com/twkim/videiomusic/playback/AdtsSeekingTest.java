package com.twkim.videiomusic.playback;

import androidx.media3.common.C;
import androidx.media3.extractor.DefaultExtractorInput;
import androidx.media3.extractor.DiscardingTrackOutput;
import androidx.media3.extractor.Extractor;
import androidx.media3.extractor.ExtractorOutput;
import androidx.media3.extractor.PositionHolder;
import androidx.media3.extractor.SeekMap;
import androidx.media3.extractor.TrackOutput;
import androidx.media3.extractor.ts.AdtsExtractor;
import java.io.ByteArrayInputStream;
import org.junit.Test;

import static org.junit.Assert.*;

public class AdtsSeekingTest {
    @Test public void defaultExtractorLeavesRawAacDurationUnknown() throws Exception {
        SeekMap map = extract(0, true);
        assertFalse(map.isSeekable());
        assertEquals(C.TIME_UNSET, map.getDurationUs());
    }

    @Test public void bitrateSeekingProvidesDurationAndMidTrackBytePosition() throws Exception {
        SeekMap map = extract(AdtsExtractor.FLAG_ENABLE_CONSTANT_BITRATE_SEEKING, true);
        assertTrue(map.isSeekable());
        // 100 AAC-LC frames, each containing 1024 samples at 44100 Hz.
        assertEquals(2_321_995, map.getDurationUs(), 1_000);
        long midpoint = map.getSeekPoints(1_000_000).first.position;
        assertTrue(midpoint > 0);
        assertTrue(midpoint < 1_300);
    }

    @Test public void missingContentLengthDoesNotInventASeekableDuration() throws Exception {
        SeekMap map = extract(AdtsExtractor.FLAG_ENABLE_CONSTANT_BITRATE_SEEKING, false);
        assertFalse(map.isSeekable());
        assertEquals(C.TIME_UNSET, map.getDurationUs());
    }

    private static SeekMap extract(int flags, boolean knownLength) throws Exception {
        // A complete ADTS AAC-LC stereo silence frame produced by FFmpeg at 44100 Hz.
        byte[] frame = {(byte) 0xff, (byte) 0xf1, 0x50, (byte) 0x80, 0x01,
                (byte) 0xbf, (byte) 0xfc, 0x21, 0x10, 0x04, 0x60, (byte) 0x8c, 0x1c};
        byte[] data = new byte[frame.length * 100];
        for (int offset = 0; offset < data.length; offset += frame.length) {
            System.arraycopy(frame, 0, data, offset, frame.length);
        }
        ByteArrayInputStream stream = new ByteArrayInputStream(data);
        DefaultExtractorInput input = new DefaultExtractorInput(
                stream::read, 0, knownLength ? data.length : C.LENGTH_UNSET);
        AdtsExtractor extractor = new AdtsExtractor(flags);
        SeekMap[] result = new SeekMap[1];
        extractor.init(new ExtractorOutput() {
            @Override public TrackOutput track(int id, int type) {
                return new DiscardingTrackOutput();
            }
            @Override public void endTracks() {}
            @Override public void seekMap(SeekMap seekMap) { result[0] = seekMap; }
        });
        try {
            PositionHolder position = new PositionHolder();
            while (extractor.read(input, position) != Extractor.RESULT_END_OF_INPUT) {}
            assertNotNull("Extractor must publish its duration and seeking contract", result[0]);
            return result[0];
        } finally {
            extractor.release();
        }
    }
}
