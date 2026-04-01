#!/usr/bin/env node
/**
 * CLI login command for Cube Exchange — Device Authorization Flow.
 *
 * Usage:
 *   npx tsx src/cli/device-login.ts              # Interactive (localhost callback)
 *   npx tsx src/cli/device-login.ts --headless    # Headless (polling with user code)
 */

import { loadCredentials, CREDENTIALS_PATH } from '../client/signing.js';
import { getEnvironment } from '../client/auth.js';
import { deviceAuthFlow, DeviceAuthError, type DeviceAuthEvent } from '../client/device-auth.js';

// ── ANSI helpers (no dependencies) ───────────────────────────

const isColorSupported = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset:   isColorSupported ? '\x1b[0m' : '',
  bold:    isColorSupported ? '\x1b[1m' : '',
  dim:     isColorSupported ? '\x1b[2m' : '',
  cyan:    isColorSupported ? '\x1b[36m' : '',
  green:   isColorSupported ? '\x1b[32m' : '',
  yellow:  isColorSupported ? '\x1b[33m' : '',
  red:     isColorSupported ? '\x1b[31m' : '',
  magenta: isColorSupported ? '\x1b[35m' : '',
  white:   isColorSupported ? '\x1b[37m' : '',
  gray:    isColorSupported ? '\x1b[90m' : '',
};

// ── ASCII Art — Impossible font (patorjk.com/software/taag) ──
//
// Adaptive: full "CUBE Exchange" on wide terminals (>=185 cols),
// "CUBE" + subtitle on standard terminals (>=62 cols),
// compact fallback on narrow terminals.

// Full "CUBE Exchange" — Impossible font, single row (182 cols)
const LOGO_FULL = [
  `     _       _                  _               _               _     _      _               _             _       _    _                   _             _              _`,
  `   /\\ \\     /\\_\\               / /\\            /\\ \\            /\\ \\ /_/\\    /\\ \\           /\\ \\           / /\\    / /\\ / /\\                /\\ \\     _    /\\ \\           /\\ \\`,
  `  /  \\ \\   / / /         _    / /  \\          /  \\ \\          /  \\ \\\\ \\ \\   \\ \\_\\         /  \\ \\         / / /   / / // /  \\              /  \\ \\   /\\_\\ /  \\ \\         /  \\ \\`,
  ` / /\\ \\ \\  \\ \\ \\__      /\\_\\ / / /\\ \\        / /\\ \\ \\        / /\\ \\ \\\\ \\ \\__/ / /        / /\\ \\ \\       / /_/   / / // / /\\ \\            / /\\ \\ \\_/ / // /\\ \\_\\       / /\\ \\ \\`,
  `/ / /\\ \\ \\  \\ \\___\\    / / // / /\\ \\ \\      / / /\\ \\_\\      / / /\\ \\_\\\\ \\__ \\/_/        / / /\\ \\ \\     / /\\ \\__/ / // / /\\ \\ \\          / / /\\ \\___/ // / /\\/_/      / / /\\ \\_\\`,
  `/ / /  \\ \\_\\  \\__  /   / / // / /\\ \\_\\ \\    / /_/_ \\/_/     / /_/_ \\/_/ \\/_/\\__/\\       / / /  \\ \\_\\   / /\\ \\___\\/ // / /  \\ \\ \\        / / /  \\/____// / / ______   / /_/_ \\/_/`,
  `/ / /    \\/_/  / / /   / / // / /\\ \\ \\___\\  / /____/\\       / /____/\\     _/\\/__\\ \\     / / /    \\/_/  / / /\\/___/ // / /___/ /\\ \\      / / /    / / // / / /\\_____\\ / /____/\\`,
  `/ / /          / / /   / / // / /  \\ \\ \\__/ / /\\____\\/      / /\\____\\/    / _/_/\\ \\ \\   / / /          / / /   / / // / /_____/ /\\ \\    / / /    / / // / /  \\/____ // /\\____\\/`,
  `/ / /________  / / /___/ / // / /____\\_\\ \\  / / /______     / / /______   / / /   \\ \\ \\ / / /________  / / /   / / // /_________/\\ \\ \\  / / /    / / // / /_____/ / // / /______`,
  `/ / /_________\\/ / /____\\/ // / /__________\\/ / /_______\\   / / /_______\\ / / /    /_/ // / /_________\\/ / /   / / // / /_       __\\ \\_\\/ / /    / / // / /______\\/ // / /_______\\`,
  `\\/____________/\\/_________/ \\/_____________/\\/__________/   \\/__________/ \\/_/     \\_\\/ \\/____________/\\/_/    \\/_/ \\_\\___\\     /____/_/\\/_/     \\/_/ \\/___________/ \\/__________/`,
];

// "CUBE" only — Impossible font (60 cols)
const LOGO_CUBE = [
  `         _       _                  _               _`,
  `       /\\ \\     /\\_\\               / /\\            /\\ \\`,
  `      /  \\ \\   / / /         _    / /  \\          /  \\ \\`,
  `     / /\\ \\ \\  \\ \\ \\__      /\\_\\ / / /\\ \\        / /\\ \\ \\`,
  `    / / /\\ \\ \\  \\ \\___\\    / / // / /\\ \\ \\      / / /\\ \\_\\`,
  `   / / /  \\ \\_\\  \\__  /   / / // / /\\ \\_\\ \\    / /_/_ \\/_/`,
  `  / / /    \\/_/  / / /   / / // / /\\ \\ \\___\\  / /____/\\`,
  ` / / /          / / /   / / // / /  \\ \\ \\__/ / /\\____\\/`,
  `/ / /________  / / /___/ / // / /____\\_\\ \\  / / /______`,
  `/ / /_________\\/ / /____\\/ // / /__________\\/ / /_______\\`,
  `\\/____________/\\/_________/ \\/_____________/\\/__________/`,
];

// Compact fallback — ANSI Regular (32 cols)
const LOGO_COMPACT = [
  ` ██████ ██    ██ ██████  ███████`,
  `██      ██    ██ ██   ██ ██`,
  `██      ██    ██ ██████  █████`,
  `██      ██    ██ ██   ██ ██`,
  ` ██████  ██████  ██████  ███████`,
];

function centerPad(line: string, width: number): string {
  // Strip ANSI codes to measure visible length
  const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, Math.floor((width - visible.length) / 2));
  return ' '.repeat(pad) + line;
}

function renderLogo(): string {
  const cols = process.stdout.columns || 80;
  let lines: string[];
  let subtitle: string;

  if (cols >= 185) {
    lines = LOGO_FULL;
    subtitle = '';
  } else if (cols >= 62) {
    lines = LOGO_CUBE;
    subtitle = `${c.dim}e  x  c  h  a  n  g  e${c.reset}`;
  } else {
    lines = LOGO_COMPACT;
    subtitle = `${c.dim}exchange${c.reset}`;
  }

  const art = lines.map(l => centerPad(`${c.cyan}${l}${c.reset}`, cols)).join('\n');
  const sub = subtitle ? '\n' + centerPad(subtitle, cols) : '';

  return `\n${art}${sub}\n`;
}

// ── Spinner ──────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private text = '';

  start(text: string) {
    this.text = text;
    if (!process.stdout.isTTY) {
      process.stdout.write(`  ${text}\n`);
      return;
    }
    this.timer = setInterval(() => {
      const spinner = `${c.cyan}${SPINNER_FRAMES[this.frame]}${c.reset}`;
      process.stdout.write(`\r  ${spinner} ${this.text}`);
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
    }, 80);
  }

  update(text: string) {
    this.text = text;
  }

  succeed(text: string) {
    this.stop();
    process.stdout.write(`\r  ${c.green}✓${c.reset} ${text}\n`);
  }

  fail(text: string) {
    this.stop();
    process.stdout.write(`\r  ${c.red}✗${c.reset} ${text}\n`);
  }

  info(text: string) {
    this.stop();
    process.stdout.write(`\r  ${c.cyan}●${c.reset} ${text}\n`);
  }

  warn(text: string) {
    this.stop();
    process.stdout.write(`\r  ${c.yellow}!${c.reset} ${text}\n`);
  }

  private stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K'); // clear line
    }
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const headless = process.argv.includes('--headless');
  const env = getEnvironment(process.env.CUBE_ENV);

  // Header
  console.log(renderLogo());

  // Check for existing valid credentials
  const existing = await loadCredentials();
  if (existing) {
    const expiresIn = existing.expiresAt - Math.floor(Date.now() / 1000);
    const days = Math.floor(expiresIn / 86400);
    const hours = Math.floor((expiresIn % 86400) / 3600);
    const timeStr = days > 0 ? `${days}d ${hours}h` : `${hours}h`;

    console.log(`  ${c.green}✓${c.reset} Already logged in ${c.dim}(expires in ${timeStr})${c.reset}`);
    console.log('');
    console.log(`    ${c.dim}Key${c.reset}       ${existing.ed25519PublicKey.slice(0, 16)}...`);
    console.log(`    ${c.dim}Provider${c.reset}  ${existing.provider}`);
    console.log(`    ${c.dim}Stored${c.reset}    ${CREDENTIALS_PATH}`);
    console.log('');
    console.log(`  ${c.dim}To re-login, delete ${CREDENTIALS_PATH}${c.reset}`);
    console.log('');
    process.exit(0);
  }

  const spinner = new Spinner();

  // Event handler — renders the polished CLI output
  const handleEvent = (event: DeviceAuthEvent) => {
    switch (event.type) {
      case 'keypair_generated':
        spinner.succeed(`Generated Ed25519 keypair ${c.dim}${event.publicKeyHex.slice(0, 12)}...${c.reset}`);
        break;

      case 'callback_server_started':
        spinner.succeed(`Callback server ready ${c.dim}:${event.port}${c.reset}`);
        break;

      case 'callback_server_failed':
        spinner.warn(`Callback server unavailable — using device code`);
        break;

      case 'device_code_received':
        if (event.userCode) {
          // Headless: show the big URL + code
          console.log('');
          console.log(`  Open this URL in any browser:`);
          console.log('');
          console.log(`    ${c.bold}${c.cyan}${event.authorizeUrl}${c.reset}`);
          console.log('');
          spinner.start(`Waiting for approval... ${c.dim}(expires in ${Math.floor(event.expiresIn / 60)}m)${c.reset}`);
        } else {
          // Interactive: opening browser
          spinner.start('Opening browser...');
        }
        break;

      case 'browser_opened':
        spinner.succeed('Browser opened');
        spinner.start(`Waiting for approval in browser... ${c.dim}(approve in the tab that just opened)${c.reset}`);
        break;

      case 'browser_failed':
        spinner.warn('Could not open browser automatically');
        console.log('');
        console.log(`  Open this URL manually:`);
        console.log('');
        console.log(`    ${c.bold}${c.cyan}${event.url}${c.reset}`);
        console.log('');
        spinner.start('Waiting for approval...');
        break;

      case 'polling': {
        const mins = Math.floor(event.elapsed / 60);
        const secs = event.elapsed % 60;
        const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        spinner.update(`Waiting for approval... ${c.dim}${elapsed} elapsed${c.reset}`);
        break;
      }

      case 'approved': {
        spinner.succeed('Approved');
        break;
      }

      case 'credentials_saved': {
        // Shown in the summary below
        break;
      }
    }
  };

  spinner.start('Generating keypair...');

  const result = await deviceAuthFlow({
    apiBase: env.restUrl,
    clientName: 'AI Crypto Fund',
    headless,
    onEvent: handleEvent,
  });

  // Final summary
  const expiryDate = new Date(result.expiresAt * 1000);
  const expiryStr = expiryDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  console.log('');
  console.log(`  ${c.green}${c.bold}✓ Successfully logged in.${c.reset}`);
  console.log('');
  console.log(`    ${c.dim}Key ID${c.reset}      ${result.verificationKeyId}`);
  console.log(`    ${c.dim}Subaccount${c.reset}  ${result.subaccountId}`);
  console.log(`    ${c.dim}Expires${c.reset}     ${expiryStr}`);
  console.log(`    ${c.dim}Saved to${c.reset}    ~/.cube/credentials.json`);
  console.log('');
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
