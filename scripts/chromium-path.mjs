import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';

function isFile(candidate) {
  if (!candidate || !existsSync(candidate)) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function commonCandidates() {
  if (process.platform === 'win32') {
    return [
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Chromium', 'Application', 'chrome.exe'),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(process.env.HOME || '', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      path.join(process.env.HOME || '', 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/snap/bin/chromium',
  ];
}

export function resolveChromiumPath() {
  const searched = [];
  for (const name of ['PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH']) {
    const candidate = process.env[name];
    if (!candidate) continue;
    searched.push(`${name}=${candidate}`);
    if (isFile(candidate)) return candidate;
  }

  try {
    const candidate = puppeteer.executablePath();
    searched.push(`puppeteer.executablePath()=${candidate || '<empty>'}`);
    if (isFile(candidate)) return candidate;
  } catch (error) {
    searched.push(`puppeteer.executablePath() threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const candidate of commonCandidates()) {
    searched.push(candidate);
    if (isFile(candidate)) return candidate;
  }

  const commands = process.platform === 'win32'
    ? ['chromium.exe', 'chrome.exe', 'msedge.exe']
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const command of commands) {
    searched.push(`PATH lookup: ${command}`);
    const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) continue;
    for (const candidate of result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      searched.push(candidate);
      if (isFile(candidate)) return candidate;
    }
  }

  throw new Error(`Could not find a Chromium executable. Searched:\n- ${searched.join('\n- ')}`);
}