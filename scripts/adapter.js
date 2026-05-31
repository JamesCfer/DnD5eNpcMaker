/**
 * D&D 5e NPC SystemAdapter — implements the BuilderApp contract for D&D 5e NPCs.
 *
 * @typedef {object} Dnd5eNpcFormData
 * @property {string} name        Creature name.
 * @property {number} level       Challenge Rating (1–30).
 * @property {string} description Free-text description for the AI.
 * @property {string} casterType  'none' | 'arcane' | 'divine' | 'primal'
 */

import { SystemAdapter, postToN8n, ActorCreationError } from './core/adapter.js';
import { N8N_BASE, devUrl, isDevMode } from './core/n8n.js';
import { detectModuleFolder,
         escapeHtml }                from './core/utils.js';
import { sanitizeActorDataDnd5e }    from './sanitizer.js';

const MODULE_FOLDER = detectModuleFolder('DnD5eNpcMaker');
const NPC_ENDPOINT  = `${N8N_BASE}/webhook/dnd5e-npc-builder`;
const LEVELUP_URL   = `${N8N_BASE}/webhook/dnd5e-npc-levelup`;

export class Dnd5eNpcAdapter extends SystemAdapter {
  get moduleFolder() { return MODULE_FOLDER; }

  get module() {
    return {
      id:           'DnD5eNpcMaker',
      label:        'D&D 5e',
      icon:         'fa-solid fa-shield-halved',
      githubUrl:    'https://github.com/JamesCfer/DnD5eNpcMaker',
      historyLabel: 'Created Creatures',
    };
  }

  get systemId() { return 'dnd5e'; }

  get supportsImageGeneration() { return true; }

  get formConfig() { return { documentNoun: 'creature' }; }

  /* ── Form handling ──────────────────────────────────────── */

  /** @returns {Dnd5eNpcFormData} */
  gatherFormData(form) {
    const fd = new FormData(form);
    const name        = (fd.get('name')?.toString()?.trim()) || 'Generated Creature';
    const level       = Number(fd.get('level')) || 1;
    const description = (fd.get('description')?.toString()?.trim()) || '';
    const casterType  = fd.get('casterType') || 'none';

    if (!description) throw new Error('Please provide a description for the creature.');
    return { name, level, description, casterType };
  }

  historyEntryFromForm(formData) {
    return {
      name:        formData.name,
      level:       formData.level,
      description: formData.description,
      casterType:  formData.casterType,
    };
  }

  historyMeta(entry) { return `CR&nbsp;${entry.level}`; }

  populateForm(form, entry) {
    const nameInput    = form.querySelector('[name="name"]');
    const levelInput   = form.querySelector('[name="level"]');
    const descTextarea = form.querySelector('[name="description"]');
    const casterSelect = form.querySelector('[name="casterType"]');
    if (nameInput)    nameInput.value    = entry.name ?? '';
    if (levelInput)   levelInput.value   = entry.level ?? 1;
    if (descTextarea) descTextarea.value = entry.description ?? '';
    if (casterSelect) casterSelect.value = entry.casterType ?? 'none';
  }

  /* ── Generation ─────────────────────────────────────────── */

  /**
   * @param {import('./core/adapter.js').GenerateOptions & { formData: Dnd5eNpcFormData }} opts
   * @returns {Promise<import('./core/adapter.js').AdapterResult>}
   */
  quickEditFields(document) {
    return [
      { key: 'name',              label: 'Name',             value: document.name,                        type: 'text' },
      { key: 'system.details.cr', label: 'Challenge Rating', value: document.system?.details?.cr ?? 1,    type: 'number', min: 0, max: 30, step: 0.125 },
    ];
  }

  async generate({ formData, key, devMode, creativity = 0.5 }) {
    const endpoint = devUrl(NPC_ENDPOINT, devMode);
    const payload  = {
      name:        formData.name,
      cr:          formData.level,
      description: formData.description,
      casterType:  formData.casterType,
      creativity,
    };

    if (formData.casterType !== 'none') {
      ui.notifications.info('Building spell mapping… (this may take 5–10 seconds)');
      payload.spellMapping = await this._buildSpellMapping();
    }

    const { response, responseText } = await postToN8n(endpoint, payload, key);

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (err) {
      throw new Error(`Invalid JSON response (${responseText.length} bytes): ${err.message}`);
    }

    if (!response.ok) throw new Error(data?.message || `Server returned status ${response.status}`);
    if (data?.ok === false) throw new Error(data?.message || data?.error || 'Server rejected the request');

    const actorData    = data.foundryNpc || data.npcDesign || data.actor || data;
    const chosenSpells = Array.isArray(data.chosenSpells) ? data.chosenSpells : [];

    if (!actorData || typeof actorData !== 'object') throw new Error('No valid actor data returned from server');
    if (!actorData.name || !actorData.type) {
      throw new Error(`Invalid actor data: missing ${!actorData.name ? 'name' : 'type'}`);
    }

    sanitizeActorDataDnd5e(actorData);

    const tokenName = actorData.name;
    const tokenImg  = actorData.img || 'icons/svg/mystery-man.svg';

    // dnd5e 5.x / Foundry v14: merge system data against the blank NPC schema
    try {
      const blankSchema = foundry.utils.deepClone(game.system.model?.Actor?.npc ?? {});
      actorData.system = foundry.utils.mergeObject(
        blankSchema,
        actorData.system ?? {},
        { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
      );
      if (!actorData.system.token || typeof actorData.system.token !== 'object') {
        actorData.system.token = {};
      }
    } catch (mergeErr) {
      console.warn('[NPC Builder] D&D 5e: schema merge failed (non-fatal):', mergeErr);
    }

    let actor;
    try {
      actor = await Actor.create(actorData);
    } catch (error) {
      throw new ActorCreationError(`Foundry rejected the actor: ${error.message}`, actorData);
    }
    if (!actor) throw new ActorCreationError('Actor creation returned null', actorData);

    await actor.update({
      'prototypeToken.name':        tokenName,
      'prototypeToken.texture.src': tokenImg,
    });

    if (chosenSpells.length > 0) {
      ui.notifications.info(`Adding ${chosenSpells.length} spells…`);
      const spellItems = [];
      for (const spell of chosenSpells) {
        try {
          const pack = game.packs.get(spell.packId);
          if (!pack) continue;
          const doc = await pack.getDocument(spell.id);
          if (doc) spellItems.push(doc.toObject());
        } catch (e) {
          console.warn('[NPC Builder] Failed to load spell:', spell.name, e.message);
        }
      }
      if (spellItems.length > 0) {
        await actor.createEmbeddedDocuments('Item', spellItems);
      }
    }

    return {
      document:   actor,
      exportData: {
        content:  JSON.stringify(actorData, null, 2),
        filename: `${actor.name || 'npc'}.json`,
        mimeType: 'application/json',
      },
      message: `NPC "${actor.name}" created successfully!`,
    };
  }

  /* ── CR Change (Level Up equivalent for 5e) ─────────────── */

  async levelUpNpc(actor, builderApp) {
    if (!builderApp.authenticated) {
      ui.notifications.warn('Please sign in with Patreon to use CR Change.');
      return;
    }

    const currentCr = actor.system?.details?.cr ?? 0;

    const content = `
      <div style="display:flex;flex-direction:column;gap:0.7em;padding:0.25em 0;">
        <p style="margin:0;">
          Adjust <strong>${escapeHtml(actor.name)}</strong>
          (currently CR <strong>${currentCr}</strong>).
        </p>
        <div style="display:flex;flex-direction:column;gap:0.25em;">
          <label for="npc-cr-target" style="font-weight:600;font-size:0.88em;">Target CR</label>
          <input type="number" id="npc-cr-target" value="${currentCr}" min="0" max="30" step="0.125"
            style="width:80px;text-align:center;padding:0.35em;border:1px solid #999;border-radius:4px;" />
        </div>
        <div style="display:flex;flex-direction:column;gap:0.25em;">
          <label for="npc-cr-instructions" style="font-weight:600;font-size:0.88em;">Adjustment Instructions</label>
          <textarea id="npc-cr-instructions" rows="4"
            placeholder="Describe changes: new abilities, updated attacks, additional resistances…"
            style="width:100%;padding:0.4em 0.5em;border:1px solid #999;border-radius:4px;font-family:inherit;font-size:0.92em;resize:vertical;box-sizing:border-box;"></textarea>
        </div>
        <p style="margin:0;font-size:0.85em;color:#666;">
          The creature will be re-generated at the target CR. Costs <strong>1 NPC use</strong>.
        </p>
      </div>`;

    const result = await foundry.applications.api.DialogV2.prompt({
      window:      { title: 'Change CR' },
      content,
      ok: {
        label:    'Generate',
        icon:     'fa-solid fa-arrow-up',
        callback: (_event, _button, dialog) => {
          const root         = dialog.element;
          const crInput      = root.querySelector('#npc-cr-target');
          const instrInput   = root.querySelector('#npc-cr-instructions');
          const cr           = crInput ? parseFloat(crInput.value) : null;
          const instructions = instrInput ? instrInput.value.trim() : '';
          return (cr !== null && !isNaN(cr)) ? { cr, instructions } : null;
        },
      },
      rejectClose: false,
    }).catch(() => null);

    if (!result) return;
    const { cr: targetCr, instructions } = result;
    if (targetCr === currentCr) {
      ui.notifications.info('Target CR is the same as current CR.');
      return;
    }

    const key = builderApp.accessKey || builderApp.storage.getKey() || '';
    if (!key) {
      builderApp.authenticated = false;
      builderApp._applyAuthStateUI();
      ui.notifications.error('Session missing. Please sign in again.');
      return;
    }

    ui.notifications.info(`Processing CR change for "${actor.name}" to CR ${targetCr}…`);

    try {
      const payload = {
        npcData:      actor.toObject(),
        targetCr,
        instructions: instructions || '',
        system:       'dnd5e',
      };

      const endpoint = devUrl(LEVELUP_URL, isDevMode(builderApp.moduleFolder));
      const { response, responseText } = await postToN8n(endpoint, payload, key);

      const data = JSON.parse(responseText);
      if (!response.ok) throw new Error(data?.message || `Server returned status ${response.status}`);

      const actorData    = data.foundryNpc || data.npcDesign || data.actor || data;
      const chosenSpells = Array.isArray(data.chosenSpells) ? data.chosenSpells : [];

      if (!actorData || typeof actorData !== 'object') {
        throw new Error('No valid actor data returned from server');
      }

      sanitizeActorDataDnd5e(actorData);

      try {
        const blankSchema = foundry.utils.deepClone(game.system.model?.Actor?.npc ?? {});
        actorData.system = foundry.utils.mergeObject(
          blankSchema,
          actorData.system ?? {},
          { inplace: false, insertKeys: true, insertValues: true, overwrite: true }
        );
        if (!actorData.system.token || typeof actorData.system.token !== 'object') {
          actorData.system.token = {};
        }
      } catch (mergeErr) {
        console.warn('[NPC Builder] D&D 5e: schema merge failed (non-fatal):', mergeErr);
      }

      let newActor;
      try {
        newActor = await Actor.create(actorData);
      } catch (error) {
        throw new ActorCreationError(`Foundry rejected the CR-adjusted actor: ${error.message}`, actorData);
      }
      if (!newActor) throw new ActorCreationError('Actor creation returned null', actorData);

      await newActor.update({
        'prototypeToken.name':        newActor.name,
        'prototypeToken.texture.src': actorData.img || 'icons/svg/mystery-man.svg',
      });

      if (chosenSpells.length > 0) {
        const spellItems = [];
        for (const spell of chosenSpells) {
          try {
            const pack = game.packs.get(spell.packId);
            if (!pack) continue;
            const doc = await pack.getDocument(spell.id);
            if (doc) spellItems.push(doc.toObject());
          } catch (e) {
            console.warn('[NPC Builder] Failed to load spell:', spell.name, e.message);
          }
        }
        if (spellItems.length > 0) await newActor.createEmbeddedDocuments('Item', spellItems);
      }

      ui.notifications.success(`"${newActor.name}" adjusted to CR ${targetCr}!`);
      newActor.sheet.render(true);
    } catch (err) {
      console.error('[NPC Builder] CR change error:', err);
      ui.notifications.error(`CR change failed: ${err.message}`);
    }
  }

  /* ── Sheet injection ────────────────────────────────────── */

  registerSheetHooks(getApp) {
    const inject = (app, html) => {
      if (!game.user?.isGM) return;
      const actor = app.actor || app.document;
      if (!actor || actor.type !== 'npc') return;

      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root) return;
      if (root.querySelector('.npc-builder-levelup-btn')) return;

      const crArea =
        root.querySelector('.challenge') ||
        root.querySelector('[data-field="system.details.cr"]')?.closest('.form-group') ||
        root.querySelector('.cr-label')?.parentElement ||
        root.querySelector('.sheet-header .stats');

      if (crArea) {
        const crBtn = document.createElement('button');
        crBtn.type = 'button';
        crBtn.className = 'npc-builder-levelup-btn';
        crBtn.innerHTML = '<i class="fa-solid fa-arrow-up"></i> Change CR';
        crBtn.title = "Adjust this creature's CR via the NPC Builder";
        crBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.levelUpNpc(actor, getApp());
        });
        crArea.parentNode.insertBefore(crBtn, crArea.nextSibling);
      }

      const acArea =
        root.querySelector('.ac') ||
        root.querySelector('.armor-class') ||
        root.querySelector('[data-field="system.attributes.ac.value"]')?.closest('.form-group') ||
        root.querySelector('.sheet-header .stats');

      if (acArea && acArea !== crArea) {
        const imageBtn = document.createElement('button');
        imageBtn.type = 'button';
        imageBtn.className = 'npc-builder-sheet-image-btn';
        imageBtn.innerHTML = '<i class="fa-solid fa-image"></i> Generate Image <span class="btn-cost-badge">4 uses</span>';
        imageBtn.title = 'Generate an AI image for this creature (costs 4 NPC uses)';
        imageBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          getApp()._generateImage(null, actor.toObject(), 'dnd5e');
        });
        acArea.parentNode.insertBefore(imageBtn, acArea);
      }
    };

    Hooks.on('renderActorSheet5e', inject);
    Hooks.on('renderActorSheet', (app, html) => {
      if (game.system?.id !== 'dnd5e') return;
      if (app.actor?.type === 'npc') inject(app, html);
    });
  }

  async _buildSpellMapping() {
    const spellMapping = [];
    const spellPacks   = game.packs.filter(pack =>
      pack.documentName === 'Item' &&
      (pack.metadata.id?.includes('spell') || pack.metadata.label?.toLowerCase().includes('spell'))
    );
    for (const pack of spellPacks) {
      const index = await pack.getIndex({ fields: ['name', 'system.level.value', 'type'] });
      for (const entry of index) {
        if (entry.type === 'spell') {
          spellMapping.push({
            name:   entry.name,
            id:     entry._id,
            packId: pack.collection,
            level:  entry.system?.level?.value ?? 0,
          });
        }
      }
    }
    return spellMapping;
  }
}
