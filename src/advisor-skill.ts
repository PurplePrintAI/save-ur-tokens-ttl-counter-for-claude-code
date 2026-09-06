import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Installs the `/ttl-advisor` Claude Code skill into the user's personal skills folder.
 *
 * The skill lets the user's own agent run the bundled transcript analyzer and explain the
 * recommendation in context (upcoming work, per-project overrides, multi-session habits).
 * Both files are copied so the skill keeps working after the extension updates or moves.
 */

export const ADVISOR_SKILL_NAME = 'ttl-advisor';
export const ADVISOR_SCRIPT_NAME = 'analyze-transcripts.js';

export function getAdvisorSkillDir(homeDir = os.homedir()): string {
  return path.join(homeDir, '.claude', 'skills', ADVISOR_SKILL_NAME);
}

export async function installAdvisorSkill(
  extensionPath: string,
  homeDir = os.homedir(),
): Promise<{ skillDir: string }> {
  const skillDir = getAdvisorSkillDir(homeDir);
  const scriptSource = path.join(extensionPath, 'bridge', ADVISOR_SCRIPT_NAME);
  const skillSource = path.join(extensionPath, 'skills', ADVISOR_SKILL_NAME, 'SKILL.md');

  await fs.mkdir(skillDir, { recursive: true });
  await fs.copyFile(scriptSource, path.join(skillDir, ADVISOR_SCRIPT_NAME));
  await fs.copyFile(skillSource, path.join(skillDir, 'SKILL.md'));

  return { skillDir };
}
