// DAB+ allowed bitrates (ETSI EN 300 401)
export const ALLOWED_BITRATES_KBPS = [
  32, 40, 48, 56, 64, 72, 80, 88, 96,
  104, 112, 120, 128, 136, 144, 152, 160,
  192, 224, 256, 320, 384
];

// Default service parameters
export const DEFAULT_BITRATE_KBPS = 88;
export const DEFAULT_ZMQ_BUFFER = 40;
export const DEFAULT_ZMQ_PREBUFFER = 20;

// ETSI EN 300 401 — PTY categories (0-29)
export const PTY_LIST = [
  { value: 0, label: 'None' },
  { value: 1, label: 'News' },
  { value: 2, label: 'Current Affairs' },
  { value: 3, label: 'Information' },
  { value: 4, label: 'Sport' },
  { value: 5, label: 'Education' },
  { value: 6, label: 'Drama' },
  { value: 7, label: 'Culture' },
  { value: 8, label: 'Science' },
  { value: 9, label: 'Varied' },
  { value: 10, label: 'Pop Music' },
  { value: 11, label: 'Rock Music' },
  { value: 12, label: 'Easy Listening' },
  { value: 13, label: 'Light Classical' },
  { value: 14, label: 'Serious Classical' },
  { value: 15, label: 'Other Music' },
  { value: 16, label: 'Weather' },
  { value: 17, label: 'Finance' },
  { value: 18, label: "Children's" },
  { value: 19, label: 'Social Affairs' },
  { value: 20, label: 'Religion' },
  { value: 21, label: 'Phone In' },
  { value: 22, label: 'Travel' },
  { value: 23, label: 'Leisure' },
  { value: 24, label: 'Jazz Music' },
  { value: 25, label: 'Country Music' },
  { value: 26, label: 'National Music' },
  { value: 27, label: 'Oldies Music' },
  { value: 28, label: 'Folk Music' },
  { value: 29, label: 'Documentary' }
];

// DAB Band III channel list (5A-13F)
export const DAB_CHANNELS = [
  '5A','5B','5C','5D','6A','6B','6C','6D',
  '7A','7B','7C','7D','8A','8B','8C','8D',
  '9A','9B','9C','9D','10A','10B','10C','10D',
  '11A','11B','11C','11D','12A','12B','12C','12D',
  '13A','13B','13C','13D','13E','13F'
];

// DAB Band III frequency table (Hz) — from ETSI EN 300 401
export const DAB_FREQ_TABLE = {
  '5A': 174928000, '5B': 176640000, '5C': 178352000, '5D': 180064000,
  '6A': 181936000, '6B': 183648000, '6C': 185360000, '6D': 187072000,
  '7A': 188928000, '7B': 190640000, '7C': 192352000, '7D': 194064000,
  '8A': 195936000, '8B': 197648000, '8C': 199360000, '8D': 201072000,
  '9A': 202928000, '9B': 204640000, '9C': 206352000, '9D': 208064000,
  '10A': 209936000, '10B': 211648000, '10C': 213360000, '10D': 215072000,
  '11A': 216928000, '11B': 218640000, '11C': 220352000, '11D': 222064000,
  '12A': 223936000, '12B': 225648000, '12C': 227360000, '12D': 229072000,
  '13A': 230784000, '13B': 232496000, '13C': 234208000, '13D': 235776000,
  '13E': 237488000, '13F': 239200000
};

export const DEFAULT_SETTINGS = {
  host: "0.0.0.0",
  // Default WebUI port (8080 is taken by lighttpd on target systems)
  port: 9090,
  // Automatically start the multiplex when the server boots
  autoStart: false,

  // If ODR tools are not in PATH, set this to e.g. "/usr/local/bin"
  odrBinDir: "",

  // Where we store presets, generated mux files, and logs
  dataDir: "./data",

  // DabMux remote control ports (local)
  dabmux: {
    telnetPort: 12721,
    managementPort: 12720,
    // dabmux remote control over ZMQ
    zmqEndpoint: "tcp://lo:12722",

    // Transmission mode: USRP1 | EDI | EASYDAB | HACKRF
    txMode: "EASYDAB",

    // EASYDAB output and raw ETI TCP monitoring output for socat/DABlin
    easyDabOutput: {
      ip: "0.0.0.0",
      port: 18081,
      netPort: 9901
    },

    // EDI-over-TCP output (only used when txMode === 'EDI')
    ediTcpListenPort: 13000,
    // Optional PFT/FEC compatibility for transmitters such as GatesAir
    ediPftEnabled: false,
    ediFec: 2,
    ediTistOffsetSec: 0,

    // HackRF output (only used when txMode === 'HACKRF')
    hackrf: {
      dabBlock: '7A',
      maxFramesQueued: 580,
      gainmode: 2,
      digitalGain: 1,
      rate: 4096000,
      txGain: 47
    }
  },

  // Authentication (password will be auto-hashed on first startup)
  auth: {
    username: "admin",
    password: "dabcast",
    mustChangePassword: true
  },

  // Default ensemble parameters (editable later)
  ensemble: {
    idHex: "0xFEFE",
    eccHex: "0xE1",
    label: "DABcast WebUI",
    shortlabel: "DABcast",
    internationalTable: 1,
    localTimeOffset: "auto"
  }
};

export const WEAK_PASSWORDS = [
  'dabcast', 'password', 'admin', 'administrator', '1234567890', '12345678901', '123456789012',
  'qwerty1234', 'letmein1234', 'changeme123'
];

export const MIN_PASSWORD_LENGTH = 10;

export const DEFAULT_DEMO_PRESET_ID = "demo";
