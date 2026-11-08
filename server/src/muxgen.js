import { ALLOWED_BITRATES_KBPS } from "./defaults.js";

function hexOrThrow(s, name) {
  if (typeof s !== "string" || !/^0x[0-9a-fA-F]+$/.test(s)) {
    throw new Error(`${name} must be like 0x1234`);
  }
  return s;
}

export function generateMuxConf({ settings, services }) {
  const ens = settings.mux.ensemble;
  hexOrThrow(ens.id, "ensemble.id");
  hexOrThrow(ens.ecc, "ensemble.ecc");

  const lines = [];
  lines.push("general {");
  lines.push("    dabmode 1");
  lines.push("    nbframes 0");
  lines.push("}");
  lines.push("");

  lines.push("remotecontrol {");
  lines.push(`    telnetport ${settings.mux.rc.telnetPort}`);
  lines.push("}");
  lines.push("");

  lines.push("ensemble {");
  lines.push(`    id ${ens.id}`);
  lines.push(`    ecc ${ens.ecc}`);
  lines.push(`    label \"${ens.label}\"`);
  lines.push(`    shortlabel \"${ens.shortlabel}\"`);
  lines.push(`    international-table ${ens.internationalTable}`);
  lines.push("    local-time-offset auto");
  lines.push("}");
  lines.push("");

  // Services
  lines.push("services {");
  services.forEach((s, idx) => {
    const key = `srv_${idx + 1}`;
    const label = (s.identity?.ps16 || s.identity?.ps8 || `Service${idx + 1}`).toString();
    const serviceId = s.dab?.serviceId ?? null;
    const pty = s.identity?.pty ?? 10;
    const language = s.identity?.languageHex ?? "0x0F"; // 0x0F = French in many examples
    lines.push(`    ${key} {`);
    if (serviceId !== null) lines.push(`        id ${asHex16(serviceId)}`);
    else lines.push(`        id ${asHex16(0x4000 + idx * 0x10)}`);
    lines.push(`        label \"${escapeLabel(label)}\"`);
    lines.push(`        pty ${pty}`);
    lines.push(`        language ${language}`);
    lines.push("    }");
  });
  lines.push("}");
  lines.push("");

  // Subchannels
  lines.push("subchannels {");
  services.forEach((s, idx) => {
    const key = `sub_${idx + 1}`;
    const port = s.network?.ediOutputTcp?.port;
    const bitrate = s.dab?.bitrateKbps;
    const protection = s.dab?.protection ?? 3;
    const buffer = s.input?.zmqBuffer ?? 96;
    const prebuf = s.input?.zmqPrebuffer ?? 48;

    if (!ALLOWED_BITRATES_KBPS.includes(bitrate)) {
      throw new Error(`Service ${s.id}: bitrate ${bitrate} not allowed`);
    }
    lines.push(`    ${key} {`);
    lines.push("        type dabplus");
    lines.push(`        inputfile \"tcp://*:${port}\"`);
    lines.push(`        zmq-buffer ${buffer}`);
    lines.push(`        zmq-prebuffering ${prebuf}`);
    lines.push(`        bitrate ${bitrate}`);
    lines.push(`        id ${idx + 1}`);
    lines.push(`        protection ${protection}`);
    lines.push("    }");
  });
  lines.push("}");
  lines.push("");

  // Components
  lines.push("components {");
  services.forEach((s, idx) => {
    const key = `comp_${idx + 1}`;
    const srvKey = `srv_${idx + 1}`;
    const subKey = `sub_${idx + 1}`;
    const label = (s.identity?.ps16 || s.identity?.ps8 || `Service${idx + 1}`).toString();
    const shortlabel = (s.identity?.ps8 || label).toString();
    lines.push(`    ${key} {`);
    lines.push(`        label \"${escapeLabel(label)}\"`);
    lines.push(`        shortlabel \"${escapeLabel(shortlabel)}\"`);
    lines.push(`        service ${srvKey}`);
    lines.push(`        subchannel ${subKey}`);
    lines.push("        figtype 0x2");
    lines.push("    }");
  });
  lines.push("}");
  lines.push("");

  lines.push("outputs {");
  lines.push(`    edi { destinations { webapp_tcp { protocol tcp listenport ${settings.mux.ediOutputTcpListenPort} } } }`);
  lines.push("    throttle \"simul://\"");
  lines.push("}");

  return lines.join("\n") + "\n";
}

function escapeLabel(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function asHex16(n) {
  const v = Number(n) & 0xffff;
  return "0x" + v.toString(16).toUpperCase().padStart(4, "0");
}
