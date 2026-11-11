function escapeLabel(value) {
  return String(value ?? '').replace(/"/g, "'");
}

export function buildMuxConfig({ settings, preset }) {
  const e = settings.ensemble;
  const txMode = (settings.dabmux?.txMode || 'EASYDAB').toUpperCase();

  // Sort services by ui.order for mux generation.
  // Services explicitly disabled (enabled === false) are left out of the multiplex (off air, CU freed).
  // Keep in sync with the sub_N mapping of /api/mux/stats in index.js.
  const sortedServices = [...preset.services].filter((s) => s.enabled !== false).sort((a, b) => (a.ui?.order ?? 0) - (b.ui?.order ?? 0));

  const lines = [];
  lines.push('general {');
  lines.push('    dabmode 1');
  lines.push('    nbframes 0');
  lines.push('    syslog false');
  lines.push('    writescca false');
  lines.push('    tist true');
  if (txMode === 'EDI') {
    const tistOffset = Number(settings.dabmux?.ediTistOffsetSec);
    if (Number.isFinite(tistOffset) && tistOffset > 0) {
      lines.push(`    tist_offset ${tistOffset}`);
    }
  }
  if (settings.dabmux.managementPort) {
    lines.push(`    managementport ${settings.dabmux.managementPort}`);
  }
  lines.push('}');
  lines.push('');
  lines.push('remotecontrol {');
  lines.push(`    telnetport ${settings.dabmux.telnetPort}`);
  const zmqEndpoint = settings.dabmux.zmqEndpoint || `tcp://lo:${settings.dabmux.zmqPort || 12722}`;
  lines.push(`    zmqendpoint ${zmqEndpoint}`);
  lines.push('}');
  lines.push('');
  lines.push('ensemble {');
  lines.push(`    id ${e.idHex}`);
  lines.push(`    ecc ${e.eccHex}`);
  lines.push(`    label "${escapeLabel(e.label)}"`);
  lines.push(`    shortlabel "${escapeLabel(e.shortlabel)}"`);
  lines.push(`    international-table ${e.internationalTable}`);
  lines.push(`    local-time-offset ${e.localTimeOffset}`);
  lines.push('    reconfig-counter hash');
  lines.push('}');
  lines.push('');

  lines.push('services {');
  sortedServices.forEach((svc, idx) => {
    const key = `srv_${idx + 1}`;
    lines.push(`    ${key} {`);
    lines.push(`        label "${escapeLabel(svc.identity.ps16 || svc.identity.ps8)}"`);
    lines.push(`        shortlabel "${escapeLabel(svc.identity.ps8)}"`);
    lines.push(`        id ${svc.identity.serviceIdHex || `0x${svc.identity.pi}`}`);
    lines.push(`        pty ${svc.identity.pty ?? 10}`);
    lines.push(`        language ${svc.identity.languageHex || '0x0F'}`);
    lines.push('    }');
  });
  lines.push('}');
  lines.push('');

  lines.push('subchannels {');
  sortedServices.forEach((svc, idx) => {
    const key = `sub_${idx + 1}`;
    const port = svc.network.ediOutputTcp.port;
    const inputMode = (svc.input?.mode || '').toUpperCase();
    lines.push(`    ${key} {`);
    lines.push('        type dabplus');
    if (inputMode === 'ZMQ') {
      // Direct ZMQ input: external encoder pushes audio to dabmux
      lines.push('        inputproto zmq');
      lines.push(`        inputuri "tcp://0.0.0.0:${port}"`);
      lines.push(`        zmq-buffer ${svc.input.zmqBuffer ?? 40}`);
      lines.push(`        zmq-prebuffering ${svc.input.zmqPrebuffering ?? 20}`);
    } else if (inputMode === 'EDI') {
      // Direct EDI input: external encoder pushes EDI/UDP to dabmux
      lines.push('        inputproto edi');
      lines.push(`        inputuri "udp://:${port}"`);
      lines.push('        buffer-management prebuffering');
      lines.push(`        buffer ${svc.input.zmqBuffer ?? 40}`);
      lines.push(`        prebuffering ${svc.input.zmqPrebuffering ?? 20}`);
    } else {
      // Default: ZMQ from local odr-audioenc (GSTREAMER / VLC modes)
      lines.push('        inputproto "zmq"');
      lines.push(`        inputuri "tcp://127.0.0.1:${port}"`);
      lines.push(`        zmq-buffer ${svc.input.zmqBuffer ?? 40}`);
      lines.push(`        zmq-prebuffering ${svc.input.zmqPrebuffering ?? 20}`);
    }
    lines.push(`        bitrate ${svc.dab.bitrateKbps}`);
    lines.push(`        id ${idx + 1}`);
    lines.push(`        protection ${svc.dab.protectionLevel ?? 3}`);
    if ((svc.dab.eepMode || 'A') === 'B') {
      lines.push('        protection-profile EEP_B');
    }
    lines.push('    }');
  });
  lines.push('}');
  lines.push('');

  lines.push('components {');
  sortedServices.forEach((svc, idx) => {
    const comp = `comp_${idx + 1}`;
    const srv = `srv_${idx + 1}`;
    const sub = `sub_${idx + 1}`;
    lines.push(`    ${comp} {`);
    lines.push(`        service ${srv}`);
    lines.push(`        subchannel ${sub}`);
    lines.push('        figtype 0x2');
    if (svc.pad?.sls?.enabled) {
      lines.push('        user-applications {');
      lines.push('            userapp "slideshow"');
      lines.push('        }');
    }
    lines.push('    }');
  });
  lines.push('}');
  lines.push('');

  lines.push('outputs {');
  if (txMode === 'USRP1') {
    lines.push('    stdout "fifo:///dev/stdout?type=raw"');
  } else if (txMode === 'EDI' || txMode === 'HACKRF') {
    const monitorIp = settings.dabmux?.easyDabOutput?.ip || '0.0.0.0';
    const monitorPort = Number(settings.dabmux?.easyDabOutput?.netPort) || 9901;
    lines.push('    throttle "simul://"');
    lines.push('    edi {');
    lines.push('        destinations {');
    lines.push('            webapp_tcp {');
    lines.push('                protocol tcp');
    lines.push(`                listenport ${settings.dabmux.ediTcpListenPort}`);
    lines.push('            }');
    lines.push('        }');
    if (txMode === 'EDI' && settings.dabmux?.ediPftEnabled === true) {
      const configuredFec = Number(settings.dabmux.ediFec);
      const fec = Number.isInteger(configuredFec) && configuredFec >= 0 ? configuredFec : 2;
      lines.push('        enable_pft true');
      lines.push(`        fec ${fec}`);
    }
    lines.push('    }');
    // Keep a raw ETI output dedicated to local monitoring. DABlin only accepts
    // EDI-AF directly, while transmitter compatibility may require EDI-PFT.
    lines.push(`    dablin "tcp://${monitorIp}:${monitorPort}"`);
  } else {
    // EASYDAB: ZMQ output
    const ip = settings.dabmux?.easyDabOutput?.ip || '0.0.0.0';
    const port = Number(settings.dabmux?.easyDabOutput?.port) || 18081;
    const netPort = Number(settings.dabmux?.easyDabOutput?.netPort) || 9901;
    lines.push('    throttle "simul://"');
    lines.push(`    zmq "zmq+tcp://${ip}:${port}"`);
    lines.push(`    net "tcp://${ip}:${netPort}"`);
  }
  lines.push('}');

  return lines.join('\n') + '\n';
}
