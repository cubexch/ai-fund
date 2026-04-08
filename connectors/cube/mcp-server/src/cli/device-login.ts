#!/usr/bin/env node
/**
 * CLI login command for Cube Exchange — Device Authorization Flow.
 *
 * Usage:
 *   npx tsx src/cli/device-login.ts              # Interactive (localhost callback)
 *   npx tsx src/cli/device-login.ts --headless    # Headless (polling with user code)
 *   npx tsx src/cli/device-login.ts --reuse-keypair  # Non-interactive: reuse existing keypair
 *   npx tsx src/cli/device-login.ts --new-keypair    # Non-interactive: generate new keypair
 *
 * When run without a TTY (e.g., from Claude Code), interactive prompts are
 * replaced with structured output. Use --reuse-keypair or --new-keypair to
 * pre-answer the keypair question. Headless mode is auto-enabled.
 */

import { loadCredentials, getBackendName, importPrivateKey, type Ed25519KeyPair } from '../client/signing';
import { getEnvironment } from '../client/auth';
import { deviceAuthFlow, DeviceAuthError, hostedAuthorizeUrl, type DeviceAuthEvent } from '../client/device-auth';
import { execFile } from 'node:child_process';

// ── ANSI helpers (no dependencies) ───────────────────────────

const isColorSupported = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: isColorSupported ? '\x1b[0m' : '',
  bold: isColorSupported ? '\x1b[1m' : '',
  dim: isColorSupported ? '\x1b[2m' : '',
  cyan: isColorSupported ? '\x1b[36m' : '',
  green: isColorSupported ? '\x1b[32m' : '',
  yellow: isColorSupported ? '\x1b[33m' : '',
  red: isColorSupported ? '\x1b[31m' : '',
  magenta: isColorSupported ? '\x1b[35m' : '',
  white: isColorSupported ? '\x1b[37m' : '',
  gray: isColorSupported ? '\x1b[90m' : '',
};

// ── Clipboard ───────────────────────────────────────────────

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const cmd = process.platform === 'darwin' ? 'pbcopy'
      : process.platform === 'win32' ? 'clip'
        : 'xclip';
    const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];

    await new Promise<void>((resolve, reject) => {
      const proc = execFile(cmd, args, { timeout: 3000 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
      proc.stdin?.write(text);
      proc.stdin?.end();
    });
    return true;
  } catch {
    return false;
  }
}

// ── Cube Logo Mark — 2×2 grid of C·U·B·E ──────────────────
//
// Based on the Cube Exchange geometric logo SVG: four thick
// letter-forms arranged in a square mark. Adaptive sizing.

// Large mark (27 cols)
const LOGO_FULL = [
  " ████████   ██       ██",
  "██      ██  ██       ██",
  "██          ██       ██",
  "██      ██  ██       ██",
  "  ███████     ███████",
  "",
  "█████████     █████████",
  "██       ██  ██",
  "█████████    ██████████",
  "██       ██  ██",
  "█████████     █████████",
];

// Compact mark (23 cols)
const LOGO_COMPACT = [
  "     ████████   ██       ██",
  "    ██      ██  ██       ██",
  "    ██          ██       ██",
  "    ██      ██  ██       ██",
  "      ███████     ███████",
  "",
  "    █████████     █████████",
  "    ██       ██  ██",
  "    █████████    ██████████",
  "    ██       ██  ██",
  "    █████████     █████████",
];

function centerPad(line: string, width: number): string {
  const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, Math.floor((width - visible.length) / 2));
  return ' '.repeat(pad) + line;
}

function renderLogo(): string {
  const pad = '      ';
  const lines = LOGO_FULL;
  const subtitle = `${c.dim}e  x  c  h  a  n  g  e${c.reset}`;

  const art = lines.map(l => `${pad}${c.cyan}${l}${c.reset}`).join('\n');
  const sub = `\n${pad} ${subtitle}`;

  return `\n${art}${sub}\n`;
}

// ── Spinner ──────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private text = '';
  private prefix = '';
  private deadlineMs = 0;

  start(text: string) {
    this.text = text;
    this.prefix = '';
    this.deadlineMs = 0;
    if (!process.stdout.isTTY) {
      process.stdout.write(`  ${text}\n`);
      return;
    }
    this.startRender();
  }

  /** Start spinner with a live countdown: "Waiting for approval... 9:42" */
  startCountdown(prefix: string, expiresInSecs: number) {
    this.prefix = prefix;
    this.deadlineMs = Date.now() + expiresInSecs * 1000;
    this.text = this.buildCountdownText();
    if (!process.stdout.isTTY) {
      process.stdout.write(`  ${this.text}\n`);
      return;
    }
    // Update countdown text every second
    this.countdownTimer = setInterval(() => {
      this.text = this.buildCountdownText();
    }, 1000);
    this.startRender();
  }

  private buildCountdownText(): string {
    const remaining = Math.max(0, Math.ceil((this.deadlineMs - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;
    return `${this.prefix} ${c.dim}${timeStr}${c.reset}`;
  }

  private startRender() {
    this.timer = setInterval(() => {
      const spinner = `${c.cyan}${SPINNER_FRAMES[this.frame]}${c.reset}`;
      process.stdout.write(`\r\x1b[K  ${spinner} ${this.text}`);
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
    }, 80);
  }

  update(text: string) {
    this.text = text;
  }

  succeed(text: string) {
    this.stop();
    process.stdout.write(`\r\x1b[K  ${c.green}✓${c.reset} ${text}\n`);
  }

  fail(text: string) {
    this.stop();
    process.stdout.write(`\r\x1b[K  ${c.red}✗${c.reset} ${text}\n`);
  }

  info(text: string) {
    this.stop();
    process.stdout.write(`\r\x1b[K  ${c.cyan}●${c.reset} ${text}\n`);
  }

  warn(text: string) {
    this.stop();
    process.stdout.write(`\r\x1b[K  ${c.yellow}!${c.reset} ${text}\n`);
  }

  private stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K');
    }
  }
}

// ── Verification Code Display ────────────────────────────────

/**
 * Print the pairing code in GitHub CLI / Stripe CLI style:
 *   ! Verify this code in your browser
 *
 *     decide - purpose - lunch - hybrid
 *
 *     Open: https://...
 */
function printVerificationCode(code: string, url?: string) {
  // Style each word bold white, separated by dim dashes
  const words = code.split('-');
  const styled = words
    .map(w => `${c.bold}${c.white}${w}${c.reset}`)
    .join(` ${c.dim}-${c.reset} `);

  console.log('');
  console.log(`  ${c.yellow}!${c.reset} Verify this code in your browser`);
  console.log('');
  console.log(`    ${styled}`);

  if (url) {
    console.log('');
    console.log(`    ${c.dim}Open:${c.reset} ${c.cyan}${url}${c.reset}`);
  }
  console.log('');
}

// ── Tail summary (last lines visible in collapsed output) ──

/**
 * Print a compact phrase + URL summary designed to be the last
 * thing visible when output is collapsed (e.g. in Claude Code).
 */
function printTailSummary(userCode: string, url: string) {
  if (!userCode && !url) return;
  const words = userCode ? userCode.split('-').map(w => `${c.bold}${c.white}${w}${c.reset}`).join(` ${c.dim}-${c.reset} `) : '';
  if (words) {
    console.log(`  ${c.yellow}Verify:${c.reset} ${words}`);
  }
  if (url) {
    console.log(`  ${c.dim}Open:${c.reset}   ${c.cyan}${url}${c.reset}`);
  }
  console.log('');
}

// ── Single-key prompt ───────────────────────────────────────

/** Wait for a single keypress and return the character. */
function waitForKey(): Promise<string> {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) { resolve('n'); return; }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (key: Buffer) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(String.fromCharCode(key[0]));
    });
  });
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isTTY = !!process.stdin.isTTY;
  const headless = args.includes('--headless');
  const forceReuse = args.includes('--reuse-keypair');
  const forceNew = args.includes('--new-keypair');
  const env = getEnvironment(process.env.CUBE_ENV);

  // Header — skip logo in non-TTY to keep output compact
  if (isTTY) {
    console.log(renderLogo());
  } else {
    console.log(`\n  ${c.cyan}${c.bold}Cube Exchange${c.reset} — Device Login\n`);
  }

  // Check for existing keypair — offer to reuse
  let existingKeyPair: Ed25519KeyPair | undefined;
  const existing = await loadCredentials();
  if (existing) {
    const pubShort = existing.ed25519PublicKey.slice(0, 12);

    let reuseKey: boolean;
    if (forceReuse) {
      reuseKey = true;
      console.log(`  ${c.dim}Existing keypair found${c.reset} ${c.dim}${pubShort}...${c.reset}`);
      console.log(`  Reusing existing keypair (--reuse-keypair)`);
    } else if (forceNew) {
      reuseKey = false;
      console.log(`  ${c.dim}Existing keypair found${c.reset} ${c.dim}${pubShort}...${c.reset}`);
      console.log(`  Generating new keypair (--new-keypair)`);
    } else if (!isTTY) {
      // Non-interactive without explicit flag — ask the caller to decide
      console.log(`  ${c.dim}Existing keypair found${c.reset} ${c.dim}${pubShort}...${c.reset}`);
      console.log('');
      console.log(`  ${c.yellow}?${c.reset} Reuse existing keypair?`);
      console.log(`    Re-run with ${c.bold}--reuse-keypair${c.reset} to keep it, or ${c.bold}--new-keypair${c.reset} to generate a fresh one.`);
      process.exit(2);
    } else {
      console.log(`  ${c.dim}Existing keypair found${c.reset} ${c.dim}${pubShort}...${c.reset}`);
      process.stdout.write(`  Reuse existing keypair? ${c.dim}[y/n]${c.reset} `);
      const key = await waitForKey();
      console.log(key);
      reuseKey = key === 'y' || key === 'Y';
    }

    if (reuseKey) {
      const seed = Uint8Array.from(Buffer.from(existing.ed25519PrivateKey, 'hex'));
      const publicKey = Uint8Array.from(Buffer.from(existing.ed25519PublicKey, 'hex'));
      const privateKey = await importPrivateKey(seed);
      existingKeyPair = { publicKey, privateKey, privateKeyRaw: seed };
    }
    console.log('');
  }

  const spinner = new Spinner();
  let codeExpiresIn = 600; // default 10 min, updated from device_code_received
  let deviceUserCode = '';  // stored for browser_opened/browser_failed display
  let authUrl = '';         // stored for display after browser opens

  // Event handler — renders the polished CLI output
  const handleEvent = async (event: DeviceAuthEvent) => {
    switch (event.type) {
      case 'keypair_generated':
        if (isTTY) spinner.succeed(`${existingKeyPair ? 'Reusing' : 'Generated'} Ed25519 keypair ${c.dim}${event.publicKeyHex.slice(0, 12)}...${c.reset}`);
        break;

      case 'callback_server_started':
        if (isTTY) spinner.succeed(`Callback server ready ${c.dim}:${event.port}${c.reset}`);
        break;

      case 'callback_server_failed':
        spinner.warn(`Callback server unavailable — using device code`);
        break;

      case 'device_code_received':
        codeExpiresIn = event.expiresIn;
        deviceUserCode = event.userCode ?? '';
        authUrl = hostedAuthorizeUrl(event.authorizeUrl);
        await copyToClipboard(authUrl);

        if (headless || !event.userCode) {
          printTailSummary(deviceUserCode, authUrl);
          spinner.startCountdown('Waiting for approval...', event.expiresIn);
          if (isTTY) console.log(`  ${c.dim}Press c to cancel${c.reset}`);
        } else {
          spinner.start('Opening browser...');
        }
        break;

      case 'browser_opened':
        spinner.succeed('Browser opened');
        printTailSummary(deviceUserCode, authUrl);
        spinner.startCountdown('Approve in the browser tab...', codeExpiresIn);
        if (isTTY) console.log(`  ${c.dim}Press c to cancel${c.reset}`);
        break;

      case 'browser_failed':
        spinner.warn('Could not open browser');
        printTailSummary(deviceUserCode, hostedAuthorizeUrl(event.url));
        spinner.startCountdown('Waiting for approval...', codeExpiresIn);
        if (isTTY) console.log(`  ${c.dim}Press c to cancel${c.reset}`);
        break;

      case 'polling':
        // Countdown timer handles the display — no-op
        break;

      case 'approved':
        spinner.succeed('Approved');
        break;

      case 'credentials_saved':
        break;
    }
  };

  // Listen for 'c' to cancel
  const cancelKeyHandler = (key: Buffer) => {
    if (key[0] === 0x63 /* c */ || key[0] === 0x03 /* Ctrl-C */) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      console.log('');
      console.log(`  ${c.yellow}Cancelled${c.reset}`);
      console.log('');
      process.exit(0);
    }
  };
  const attachCancelHandler = () => {
    if (!process.stdin.isTTY) {
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', cancelKeyHandler);
  };
  const detachCancelHandler = () => {
    if (!process.stdin.isTTY) {
      return;
    }
    process.stdin.off('data', cancelKeyHandler);
  };
  attachCancelHandler();
  spinner.start(existingKeyPair ? 'Reusing keypair...' : 'Generating keypair...');

  const result = await deviceAuthFlow({
    apiBase: env.restUrl,
    clientName: 'AI Fund',
    headless,
    onEvent: handleEvent,
    existingKeyPair,
  });

  // Stop listening for cancel
  if (process.stdin.isTTY) {
    detachCancelHandler();
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  // ── Post-login summary ──
  const backend = await getBackendName();
  const expiryDate = new Date(result.expiresAt * 1000);
  const expiryStr = expiryDate.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const expiresIn = result.expiresAt - Math.floor(Date.now() / 1000);
  const days = Math.floor(expiresIn / 86400);

  console.log('');
  console.log(`  ${c.green}${c.bold}Done!${c.reset} Cube Exchange CLI is now configured.`);
  console.log('');
  console.log(`    ${c.dim}Key ID${c.reset}       ${result.verificationKeyId}`);
  if (result.subaccountId) {
    console.log(`    ${c.dim}Subaccount${c.reset}   ${result.subaccountId}`);
  }
  console.log(`    ${c.dim}Public Key${c.reset}   ${result.keyPair ? Buffer.from(result.keyPair.publicKey).toString('hex').slice(0, 16) + '...' : '—'}`);
  console.log(`    ${c.dim}Expires${c.reset}      ${expiryStr}`);
  console.log(`    ${c.dim}Stored in${c.reset}    ${backend === 'keychain' ? 'macOS Keychain' : backend === 'secret-tool' ? 'System keyring' : '~/.cube/credentials.json'}`);
  console.log('');
  console.log(`  ${c.dim}Note: this key will expire in ${days} days. Re-run to re-authenticate.${c.reset}`);
  console.log('');
  console.log(`  ${c.green}Login successful.${c.reset}`);
  process.exit(0);
}

main().catch(err => {
  console.log('');
  if (err instanceof DeviceAuthError) {
    switch (err.code) {
      case 'access_denied':
        console.log(`  ${c.red}${c.bold}✗ Authorization denied${c.reset}`);
        console.log(`  ${c.dim}The request was denied in the browser.${c.reset}`);
        break;
      case 'expired_token':
      case 'callback_timeout':
        console.log(`  ${c.red}${c.bold}✗ Session expired${c.reset}`);
        console.log(`  ${c.dim}The authorization window timed out. Run the command again.${c.reset}`);
        break;
      default:
        console.log(`  ${c.red}${c.bold}✗ Login failed${c.reset}`);
        console.log(`  ${c.dim}${err.message}${c.reset}`);
    }
  } else {
    console.log(`  ${c.red}${c.bold}✗ Login failed${c.reset}`);
    console.log(`  ${c.dim}${err.message ?? err}${c.reset}`);
  }
  console.log('');
  process.exit(1);
});
