import path from "path";
import { nanoid } from "nanoid";
import { ALLOWED_BITRATES_KBPS } from "./defaults.js";

export function makeDemoPreset({ baseMotDir }) {
  const services = [
    {
      id: "MAXXIMA",
      enabled: true,
      identity: { pi: "4DB0", ps8: "MAXXIMA", ps16: "MAXXIMA", pty: 10, languageHex: "0x0F" },
      dab: { bitrateKbps: 88, protection: 3, cu: 0 },
      input: { mode: "AUDIOENC", uri: "http://maxxima.mine.nu:8000/", backupUri: null, zmqBuffer: 96, zmqPrebuffer: 48 },
      audio: { channels: 2, sampleRateHz: 48000, gainDb: 0 },
      pad: { enabled: true, fifoName: "MAXXIMA", dlsFile: "MAXXIMA.dls", slideDir: "slide" },
      mot: { dir: path.join(baseMotDir, "MAXXIMA") },
      network: { ediOutputTcp: { host: "127.0.0.1", port: 9001 } },
      watchdog: { enabled: true, silenceThresholdSec: 10, switchToBackup: true, returnToMainAfterSec: 60 }
    },
    {
      id: "FIP",
      enabled: true,
      identity: { pi: "F204", ps8: "F I P", ps16: "F I P", pty: 12, languageHex: "0x0F" },
      dab: { bitrateKbps: 88, protection: 3, cu: 0 },
      input: { mode: "AUDIOENC", uri: "http://direct.fipradio.fr/live/fip-midfi.mp3", backupUri: null, zmqBuffer: 96, zmqPrebuffer: 48 },
      audio: { channels: 2, sampleRateHz: 48000, gainDb: 0 },
      pad: { enabled: true, fifoName: "FIP", dlsFile: "FIP.dls", slideDir: "slide" },
      mot: { dir: path.join(baseMotDir, "FIP") },
      network: { ediOutputTcp: { host: "127.0.0.1", port: 9002 } },
      watchdog: { enabled: true, silenceThresholdSec: 10, switchToBackup: true, returnToMainAfterSec: 60 }
    },
    {
      id: "CLASSIC21",
      enabled: true,
      identity: { pi: "6354", ps8: "CLASS21", ps16: "CLASSIC21", pty: 11, languageHex: "0x0F" },
      dab: { bitrateKbps: 88, protection: 3, cu: 0 },
      input: { mode: "AUDIOENC", uri: "http://radios.rtbf.be/classic21-128.mp3", backupUri: null, zmqBuffer: 96, zmqPrebuffer: 48 },
      audio: { channels: 2, sampleRateHz: 48000, gainDb: 0 },
      pad: { enabled: true, fifoName: "CLASSIC21", dlsFile: "CLASSIC21.dls", slideDir: "slide" },
      mot: { dir: path.join(baseMotDir, "CLASSIC21") },
      network: { ediOutputTcp: { host: "127.0.0.1", port: 9003 } },
      watchdog: { enabled: true, silenceThresholdSec: 10, switchToBackup: true, returnToMainAfterSec: 60 }
    },
    {
      id: "RVM",
      enabled: true,
      identity: { pi: "F750", ps8: "RVM", ps16: "RVM", pty: 10, languageHex: "0x0F" },
      dab: { bitrateKbps: 88, protection: 3, cu: 0 },
      input: { mode: "AUDIOENC", uri: "http://stream.rvm.fr:8022/stream.mp3", backupUri: null, zmqBuffer: 96, zmqPrebuffer: 48 },
      audio: { channels: 2, sampleRateHz: 48000, gainDb: 0 },
      pad: { enabled: true, fifoName: "RVM", dlsFile: "RVM.dls", slideDir: "slide" },
      mot: { dir: path.join(baseMotDir, "RVM") },
      network: { ediOutputTcp: { host: "127.0.0.1", port: 9004 } },
      watchdog: { enabled: true, silenceThresholdSec: 10, switchToBackup: true, returnToMainAfterSec: 60 }
    }
  ];

  // Validate bitrates
  for (const s of services) {
    if (!ALLOWED_BITRATES_KBPS.includes(s.dab.bitrateKbps)) {
      throw new Error(`Demo preset has invalid bitrate for ${s.id}`);
    }
  }

  return {
    presetId: `demo_${nanoid(6)}`,
    name: "DABcast",
    createdAt: new Date().toISOString(),
    services,
    ui: { order: services.map((s) => s.id) }
  };
}
