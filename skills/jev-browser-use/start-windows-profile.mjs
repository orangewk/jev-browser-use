#!/usr/bin/env node
import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

async function exists(path) {
  try { return (await stat(path)).isFile(); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function chromeCandidates(env=process.env) {
  return [
    env.PROGRAMFILES && join(env.PROGRAMFILES,'Google','Chrome','Application','chrome.exe'),
    env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'],'Google','Chrome','Application','chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe')
  ].filter(Boolean);
}

export async function findChrome(env=process.env) {
  for (const candidate of chromeCandidates(env)) if (await exists(candidate)) return candidate;
  throw new Error('Google Chrome was not found');
}

export function profileDirectory(env=process.env) {
  return env.JEV_BROWSER_PROFILE_DIR || join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'),'JevBrowser','User Data');
}

export async function startProfile({env=process.env,url='https://x.com/'}={}) {
  const chrome=await findChrome(env);
  const profile=profileDirectory(env);
  await mkdir(profile,{recursive:true});
  const child=spawn(chrome,[`--user-data-dir=${profile}`,'--profile-directory=Default','--no-default-browser-check',url],{detached:true,stdio:'ignore'});
  child.unref();
  return {chrome,profile,pid:child.pid};
}

if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/(.:)/,'$1').replaceAll('/','\\').toLowerCase() === process.argv[1].toLowerCase()) {
  startProfile().then(result=>console.log(`Jev Browser started. Profile: ${result.profile}`)).catch(error=>{
    console.error(error instanceof Error ? error.message : 'Failed to start Jev Browser');
    process.exitCode=1;
  });
}
