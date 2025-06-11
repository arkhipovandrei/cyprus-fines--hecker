import { createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import process from 'process';
import axios from 'axios';
import nodeNotify from 'node-notifier';
import { TelegramBot } from 'telegram-bot-api';

// Constants
const CONFIG_FILE = '.cycamerasystembot';
const CONFIG_YAML = '.cycamerasystembot.yaml';
const API_URL = 'https://cycamerasystem.com.cy';

const httpClient = axios.create({
  timeout: 5000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en,ru;q=0.9,en-US;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Priority': 'u=1, i',
    'Referer': `${API_URL}/Login`,
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  }
});

// Config structure
class Config {
  constructor({
    telegramToken,
    telegramMyID,
    plates,
    arc,
    passport
  }) {
    this.telegramToken = telegramToken;
    this.telegramMyID = telegramMyID;
    this.plates = plates;
    this.arc = arc;
    this.passport = passport;
  }
}

// Challenge structure
class Challenge {
  constructor({
    algorithm,
    challenge,
    salt,
    signature
  }) {
    this.algorithm = algorithm;
    this.challenge = challenge;
    this.salt = salt;
    this.signature = signature;
  }
}

// Challenge solution structure
class ChallengeSolution extends Challenge {
  constructor(challenge, number, took) {
    super(challenge);
    this.number = number;
    this.took = took;
  }
}

// Tickets structure
class Tickets {
  constructor({
    isError = false,
    message = '',
    resultsList = [],
    validationList = {}
  }) {
    this.isError = isError;
    this.message = message;
    this.resultsList = resultsList;
    this.validationList = validationList;
  }

  empty() {
    return !this.isError && 
           this.resultsList.length === 0 && 
           Object.keys(this.validationList).length === 0;
  }
}

// All tickets structure
class AllTickets {
  constructor({
    arc = null,
    passport = null,
    foreignID = null,
    errors = []
  }) {
    this.arc = arc;
    this.passport = passport;
    this.foreignID = foreignID;
    this.errors = errors;
  }

  empty() {
    return (!this.arc || this.arc.empty()) &&
           (!this.passport || this.passport.empty()) &&
           (!this.foreignID || this.foreignID.empty()) &&
           this.errors.length === 0;
  }
}

// Helper functions
function notifyError(err) {
  nodeNotify.notify({
    title: 'Error',
    message: err.message
  });
}

function notifyMessage(text) {
  nodeNotify.notify({
    title: 'Message',
    message: text
  });
}

async function reportError(telegramMyID, tg, err) {
  try {
    await tg.sendMessage(telegramMyID, err.message);
  } catch (err) {
    notifyError(err);
  }
}

async function reportTickets(telegramMyID, tg, plate, tickets) {
  console.log('Plate', plate);

  if (tickets.empty()) {
    console.log('No tickets');
    return;
  }

  const text = JSON.stringify(tickets, null, 2);
  try {
    await tg.sendMessage(telegramMyID, text);
  } catch (err) {
    notifyError(err);
    notifyMessage(text);
  }

  console.log(text);
}

async function shouldRun() {
  try {
    const home = homedir();
    const filePath = join(home, CONFIG_FILE);
    
    try {
      const content = await readFile(filePath, 'utf8');
      const lastRun = new Date(content);
      return (Date.now() - lastRun) >= 24 * 60 * 60 * 1000;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return true;
      }
      throw err;
    }
  } catch (err) {
    throw new Error(`shouldRun failed: ${err.message}`);
  }
}

async function saveTime() {
  try {
    const home = homedir();
    const filePath = join(home, CONFIG_FILE);
    await writeFile(filePath, new Date().toISOString());
  } catch (err) {
    throw new Error(`saveTime failed: ${err.message}`);
  }
}

async function loadConfig() {
  try {
    const home = homedir();
    const filePath = join(home, CONFIG_YAML);
    const content = await readFile(filePath, 'utf8');
    
    const config = {};
    content.split('\n').forEach(line => {
      const [key, value] = line.split(':').map(s => s.trim());
      if (key && value) {
        if (key === 'telegramMyID') {
          config[key] = parseInt(value);
        } else if (key === 'plates') {
          config[key] = value.split(',').map(s => s.trim());
        } else {
          config[key] = value;
        }
      }
    });
    
    return new Config(config);
  } catch (err) {
    throw new Error(`loadConfig failed: ${err.message}`);
  }
}

async function genChallenge() {
  try {
    const response = await httpClient.get(`${API_URL}/Search/GenerateChallenge`);
    return new Challenge(response.data);
  } catch (err) {
    throw new Error(`genChallenge failed: ${err.message}`);
  }
}

function solveChallengeSync(challenge) {
  const salt = Buffer.from(challenge.salt);
  const challengeBytes = Buffer.from(challenge.challenge, 'hex');

  let hashFunction;
  switch (challenge.algorithm) {
    case 'SHA-256':
      hashFunction = 'sha256';
      break;
    case 'SHA-384':
      hashFunction = 'sha384';
      break;
    case 'SHA-512':
      hashFunction = 'sha512';
      break;
    default:
      throw new Error(`Unknown algorithm: ${challenge.algorithm}`);
  }

  const start = Date.now();
  for (let i = 0; i < 100000; i++) {
    const hash = createHash(hashFunction);
    hash.update(salt);
    hash.update(Buffer.from(i.toString()));
    const sum = hash.digest();

    if (sum.equals(challengeBytes)) {
      return new ChallengeSolution(
        challenge,
        i,
        (Date.now() - start) * 10
      );
    }
  }

  throw new Error('Challenge is unsolvable');
}

async function solveChallenge() {
  const challenge = await genChallenge();
  return solveChallengeSync(challenge);
}

async function findTickets(solution, idType, idValue, plate) {
  try {
    const sol = JSON.stringify(solution);
    const form = new URLSearchParams();
    form.append('IdType', idType);
    form.append('IdValue', idValue);
    form.append('Plate', plate);
    form.append('altcha', Buffer.from(sol).toString('base64'));

    const response = await httpClient.post(`${API_URL}/Search/Search`, form.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': API_URL,
        'X-Requested-With': 'XMLHttpRequest'
      }
    });

    return new Tickets(response.data);
  } catch (err) {
    throw new Error(`findTickets failed: ${err.message}`);
  }
}

async function main() {
  try {
    const run = await shouldRun();
    if (!run) {
      console.log('Too early');
      return;
    }

    const cfg = await loadConfig();
    const tg = new TelegramBot({
      token: cfg.telegramToken
    });

    try {
      const solution = await solveChallenge();

      for (const plate of cfg.plates) {
        const allTickets = new AllTickets({});
        const promises = [];

        // ARC check
        promises.push((async () => {
          try {
            const tickets = await findTickets(solution, 'arc_number', cfg.arc, plate);
            allTickets.arc = tickets;
          } catch (err) {
            allTickets.errors.push(`arc: ${err.message}`);
          }
        })());

        // Passport check
        promises.push((async () => {
          try {
            const tickets = await findTickets(solution, 'passport', cfg.passport, plate);
            allTickets.passport = tickets;
          } catch (err) {
            allTickets.errors.push(`passport: ${err.message}`);
          }
        })());

        // Foreign ID check
        promises.push((async () => {
          try {
            const tickets = await findTickets(solution, 'foreign_id', cfg.passport, plate);
            allTickets.foreignID = tickets;
          } catch (err) {
            allTickets.errors.push(`foreign: ${err.message}`);
          }
        })());

        await Promise.all(promises);
        await reportTickets(cfg.telegramMyID, tg, plate, allTickets);
      }

      await saveTime();
      console.log('Success');
    } catch (err) {
      await reportError(cfg.telegramMyID, tg, err);
    }
  } catch (err) {
    notifyError(err);
  }
}

// Handle process termination
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());

// Run the main function
main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
