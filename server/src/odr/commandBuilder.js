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
// Player used for a URI of the service: the backup stream can have its own (input.backupMode:
// GSTREAMER / VLC; '' or missing = same as main). A sound card main source (ALSA) always needs a
// stream player for its backup: GStreamer when none is set.
export function inputModeFor(svc, uri) {
  const main = String(svc.input?.mode || '').toUpperCase();
  const onBackup = Boolean(svc.input?.backupUri) && uri === svc.input.backupUri && uri !== svc.input?.uri;
  if (!onBackup) return main;
  const b = String(svc.input?.backupMode || '').toUpperCase();
  if (b === 'GSTREAMER' || b === 'VLC') return b;
  return main === 'ALSA' ? 'GSTREAMER' : main;
}
// Sound card: seconds of silence before odr-audioenc stops (then the watchdog restarts it, or switches
// to the backup stream) = the service's "Silence threshold", 30 s when not set, at least 5 s.
// Streams keep the fixed 180 s.
export const ALSA_SILENCE_DEFAULT_SEC = 30;
const alsaSilenceSec = (svc) => Math.max(5, Math.round(Number(svc.watchdog?.silenceThresholdSec ?? ALSA_SILENCE_DEFAULT_SEC)) || ALSA_SILENCE_DEFAULT_SEC);

export function buildAudioEncCommand({ svc, activeUri, mtaPath }) {
  const mode = inputModeFor(svc, activeUri);
  const isGst = mode.includes('GST');
  // Respect user choice: only use -G if explicitly set to GST mode
  const sourceFlag = isGst ? '-G' : '-v';
  const codecArgs = svc.audio?.codecArgs || [];

  const args = [];

  // 1. Codec flags (--sbr, --ps, etc.)
  args.push(...codecArgs);

  // 2. Level indicator
  args.push('-l');

  // 3. Input source
  // ALSA (local sound card, input.uri = device such as plughw:1,0): odr-audioenc reads it itself (-d);
  // -D always: a sound card clock never runs exactly at the DAB clock (else "input empty" underruns)
  const isAlsa = mode === 'ALSA';
  if (isAlsa) args.push('-d', activeUri, '-D');
  else args.push(sourceFlag, activeUri);

  // 4. VLC-specific options (resampler + buffer + drift comp) - only for VLC mode
  if (!isAlsa && sourceFlag === '-v') {
    args.push(
      '-L', '--audio-resampler=speex-resampler',
      '-L', '--speex-resampler-quality=10',
      '-C', String(svc.input.encoderBufferMs ?? 200)
    );
    // Drift compensation for non-network sources (ALSA/file), or on HTTP when the service
    // opts in (input.driftComp: source whose clock runs slow/fast → periodic dabmux underruns)
    if (!isHttpStream(activeUri) || svc.input?.driftComp === true) {
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
    '-s', isAlsa ? String(alsaSilenceSec(svc)) : '180'  // silence timeout 180s (sound card: see alsaSilenceSec)
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
  const isAlsa = String(mode || '').toUpperCase() === 'ALSA';   // sound card main source: is the sound back?
  return {
    bin: 'odr-audioenc',
    args: [
      ...(isAlsa ? ['-d', uri] : [sourceFlag, uri]),
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
// soapy (optional): { device, txGain, freqHz, masterClockRate, bandwidth, txAntenna } = odr-dabmod drives
// the SDR itself through SoapySDR instead of writing to the FIFO read by hackrf_transfer. Values are the
// final ones (the caller adapts them to the device). bandwidth 0 / txAntenna '' = not written (driver default).
export function buildDabModConfig({ source, maxFramesQueued, gainmode, digitalGain, rate, filtertapsPath, fifoPath, soapy }) {
  const output = soapy ? [
    '[output]',
    'output=soapysdr',
    '',
    '[soapyoutput]',
    `device=${soapy.device}`,
    `master_clock_rate=${soapy.masterClockRate || 0}`,
    `txgain=${soapy.txGain}`,
    `frequency=${soapy.freqHz}`,
    ...(soapy.bandwidth ? [`bandwidth=${soapy.bandwidth}`] : []),
    ...(soapy.txAntenna ? [`tx_antenna=${soapy.txAntenna}`] : [])
  ] : [
    '[output]',
    'output=file',
    '',
    '[fileoutput]',
    'format=s8',
    `filename=${fifoPath}`
  ];
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
    ...output
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
