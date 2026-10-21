// Create the first security officer account, once (web access, step 5).
//
//   npm run create-first-admin -- --username sec.admin [--display-name "Security Admin"]
//   npm run create-first-admin -- --username sec.admin --password-stdin < (a secret from your vault)
//
// It starts OpsPilot with the same environment as the server (AUDIT_LOG_KEY, the
// database), so the account is created through the same checks and written to the
// same keyed, anchored audit log; then it stops. It is refused once any account
// exists: after that, a security officer creates accounts through the API.
//
// The password is asked for twice on the terminal and never echoed. It is never
// read from an argument or an environment variable, where it would be left in the
// shell history or the process listing. --password-stdin reads the first line of
// standard input instead, for scripted setups that take it from a secret store.

import { pathToFileURL } from 'node:url';

import { startOpsPilot } from '../system.js';
import { AccountError } from './accounts.js';

export async function createFirstAdmin({ env, username, displayName, readPassword, print = console.log }) {
  const password = await readPassword();
  // The API and the dashboard are not wanted for this; only the services.
  const system = await startOpsPilot({ env: { ...env, WEB_PORT: '', DASHBOARD_PORT: '' } });
  try {
    const account = await system.services.accounts.bootstrapFirstAdmin({ username, password, displayName: displayName ?? username });
    print(`Created the first security officer account "${account.id}". Sign in through the API to create the others.`);
    return account;
  } finally {
    await system.stop();
  }
}

// ---------------------------------------------------------------------------

function argValue(args, name) {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
}

// Reads one line from the terminal without echoing it.
function readHidden(prompt) {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    let text = '';
    const finish = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') { finish(); resolve(text); return; }
        if (c === '\u0003') { finish(); reject(new Error('Cancelled.')); return; }
        if (c === '\u007f' || c === '\b') text = text.slice(0, -1);
        else text += c;
      }
    };
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readFirstLine(stream) {
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    if (text.includes('\n')) break;
  }
  return text.split(/\r?\n/)[0];
}

async function main(args) {
  const username = argValue(args, '--username');
  if (!username) throw new AccountError('Give the account a name: --username sec.admin');
  let readPassword;
  if (args.includes('--password-stdin')) {
    readPassword = () => readFirstLine(process.stdin);
  } else {
    if (!process.stdin.isTTY) throw new AccountError('Run this in a terminal so the password can be typed without being shown, or use --password-stdin.');
    readPassword = async () => {
      const first = await readHidden('Password for the first security officer (12+ characters, not shown): ');
      const again = await readHidden('The same password again: ');
      if (first !== again) throw new AccountError('The two passwords were not the same; nothing was created.');
      return first;
    };
  }
  await createFirstAdmin({ env: process.env, username, displayName: argValue(args, '--display-name'), readPassword });
}

// Run when called as a script, not when imported by a test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    () => { process.exitCode = 0; },
    (err) => {
      // An AccountError is a refusal with a plain reason; anything else is shown in full.
      console.error(err instanceof AccountError || err?.name === 'StartupRefusedError' ? `Not created: ${err.message}` : err);
      process.exitCode = 1;
    },
  );
}
