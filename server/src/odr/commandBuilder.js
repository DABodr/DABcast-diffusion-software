function isHttpStream(uri) {
  return /^https?:\/\//i.test(uri || '');
}

// odr-padenc command builder
// dlsPath should be absolute path to DLS file (e.g., data/runtime/F124.dls)
export function buildPadEncCommand(svc, motDirAbs, dlsPath) {
  return {
    bin: 'odr-padenc',
    args: [
      '-d', motDirAbs || svc.pad.slideDir,
      '-o', svc.pad.fifoName,
      '-t', dlsPath || svc.pad.dlsFile,  // Use absolute dlsPath if provided
      '-s', '1'                          // 1 sec between slides
    ]
  };
}

// odr-audioenc command builder
export function buildAudioEncCommand({ svc, activeUri, mtaPath }) {
  const isGst = svc.input?.mode?.toUpperCase().includes('GST');
  // Respect user choice: only use -G if explicitly set to GST mode
  const sourceFlag = isGst ? '-G' : '-v';
  const codecArgs = svc.audio?.codecArgs || [];

  const args = [];

  // 1. Codec flags (--sbr, --ps, etc.)
  args.push(...codecArgs);

  // 2. Level indicator
  args.push('-l');

  // 3. Input source
  args.push(sourceFlag, activeUri);

  // 4. VLC-specific options (resampler + buffer + drift comp) - only for VLC mode
  if (sourceFlag === '-v') {
    args.push(
      '-L', '--audio-resampler=speex-resampler',
      '-L', '--speex-resampler-quality=10',
      '-C', String(svc.input.encoderBufferMs ?? 200)
    );
    // Drift compensation only for non-network sources (ALSA/file)
    if (!isHttpStream(activeUri)) {
      args.push('-D');
    }
  }

  // 5. Audio parameters
  args.push(
    '-c', String(svc.audio.channels ?? 2),
    '-p', String(svc.dab.padSize ?? 58),
    '-b', String(svc.dab.bitrateKbps),
    '-r', String(svc.audio.sampleRateHz ?? 48000),
    '-g', String(svc.audio.gainDb ?? 0),
    '-s', '180'  // silence timeout 180s
  );

  // 6. Output (ZMQ)
  args.push('-o', `tcp://localhost:${svc.network.ediOutputTcp.port}`);

  // 7. MTA + PAD
  args.push('-w', mtaPath, '-P', svc.pad.fifoName);

  return { bin: 'odr-audioenc', args };
}

// Probe encoder: minimal odr-audioenc to detect audio presence on a URI.
// Sends to a ZMQ sink port (nobody listening). Exits after -s seconds of silence.
// No PAD, no MTA, mono 32kbps to minimize CPU load.
export function buildProbeCommand(uri, mode) {
  const isGst = String(mode || '').toUpperCase().includes('GST');
  const sourceFlag = isGst ? '-G' : '-v';
  return {
    bin: 'odr-audioenc',
    args: [
      sourceFlag, uri,
      '-c', '1',      // mono — less CPU
      '-b', '32',     // 32 kbps minimum
      '-r', '48000',
      '-g', '0',
      '-s', '15',     // silence timeout = probe duration
      '-o', 'tcp://localhost:9099'
    ]
  };
}

export function buildDabMuxCommand(muxPath) {
  return { bin: 'odr-dabmux', args: ['-e', muxPath] };
}

// Generate dabmod.ini content from parameters
export function buildDabModConfig({ source, maxFramesQueued, gainmode, digitalGain, rate, filtertapsPath, fifoPath }) {
  return [
    '[remotecontrol]',
    'telnet=1',
    'telnetport=2121',
    '',
    '[input]',
    'transport=edi',
    `source=${source}`,
    `max_frames_queued=${maxFramesQueued}`,
    '',
    '[modulator]',
    `gainmode=${gainmode}`,
    `digital_gain=${digitalGain}`,
    `rate=${rate}`,
    '',
    '[firfilter]',
    'enabled=1',
    `filtertapsfile=${filtertapsPath}`,
    '',
    '[output]',
    'output=file',
    '',
    '[fileoutput]',
    'format=s8',
    `filename=${fifoPath}`
  ].join('\n') + '\n';
}

// hackrf_transfer command builder
export function buildHackrfTransferCommand({ fifoPath, freqHz, txGain, rate }) {
  return {
    bin: 'hackrf_transfer',
    args: [
      '-t', fifoPath,
      '-f', String(freqHz),
      '-x', String(txGain),
      '-a', '1',
      '-s', String(rate),
      '-b', '1750000'
    ]
  };
}
