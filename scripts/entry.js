/**
 * D&D 5e NPC Maker — module entry point.
 */

import { openBuilder }          from './core/app.js';
import { checkForModuleUpdate } from './core/update-check.js';
import { registerSidebar }      from './core/sidebar.js';
import { Dnd5eNpcAdapter }      from './adapter.js';

const adapter   = new Dnd5eNpcAdapter();
const MODULE_ID = adapter.module.id;

const openFn = () => {
  openBuilder(adapter);
  checkForModuleUpdate(MODULE_ID, adapter.module.githubUrl).catch(() => {});
};

registerSidebar(MODULE_ID, openFn, {
  buttonLabel: 'NPC Builder',
  buttonIcon:  '★',
  directories: ['actors', 'compendium'],
});

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'devMode', {
    name:   'Developer Mode',
    hint:   'When enabled, all webhook URLs are routed to the -dev endpoints. Disable before going live.',
    scope:  'world', config: true, type: Boolean, default: false,
  });

  game.settings.register(MODULE_ID, 'welcomeMessageShown', {
    scope:  'world', config: false, type: Boolean, default: false,
  });
});

Hooks.once('ready', () => {
  const mod = game.modules?.get(MODULE_ID);
  const currentVersion = mod?.version || '';

  const storedVersionKey = `${MODULE_ID}.module-version`;
  let storedVersion = '';
  try { storedVersion = localStorage.getItem(storedVersionKey) || ''; } catch (_) {}

  if (currentVersion && storedVersion && currentVersion !== storedVersion) {
    try {
      localStorage.removeItem(`${MODULE_ID}.key`);
      localStorage.removeItem(`${MODULE_ID}:key`);
    } catch (_) {}
    ui.notifications?.info?.('NPC Builder was updated — please sign in again.');
  }
  if (currentVersion) {
    try { localStorage.setItem(storedVersionKey, currentVersion); } catch (_) {}
  }

  (foundry.applications.handlebars?.loadTemplates ?? loadTemplates)([
    `modules/${MODULE_ID}/templates/builder.html`,
  ]);
  console.log(`DnD 5e NPC Auto-Builder ready (version: ${currentVersion}).`);

  if (game.user.isGM && !game.settings.get(MODULE_ID, 'welcomeMessageShown')) {
    const welcomeContent = `
<h3>Welcome to the D&D 5e NPC Auto-Builder!</h3>
<p>Here's how to get started:</p>
<ol>
  <li><strong>Open the Builder</strong> — Click the <em>NPC Builder</em> button in the <strong>Actors</strong> or <strong>Compendium</strong> sidebar header.</li>
  <li><strong>Sign In</strong> — Click <em>Sign in with Patreon</em> to authenticate.</li>
  <li><strong>Describe Your Creature</strong> — Fill in a name, CR, caster type, and description.</li>
  <li><strong>Generate!</strong> — A fully-statted creature is added to your world.</li>
</ol>
<p>Check the <strong>Home</strong> tab inside the builder to discover the other CferNpcMaker modules (PF2e, Hero 6e, and PF2e Items).</p>`.trim();

    ChatMessage.create({
      content: welcomeContent,
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
    });
    game.settings.set(MODULE_ID, 'welcomeMessageShown', true);
  }
});
