/**
 * AI spec pack (PRD §10.2): one markdown document an external chatbot needs to
 * write a valid .kkgroup patch. Generated at runtime from the live module
 * registry so it can never drift from the actual module set.
 */

import { MODULE_DEFS } from './registry';

const FORMAT_RULES = `
## Patch format (.kkgroup)

Reply with ONE JSON code block, no prose inside it:

\`\`\`json
{
  "kind": "kkgroup",
  "formatVersion": 1,
  "name": "Short patch name",
  "modules": [
    { "id": "osc1", "type": "osc", "params": { "wave": 3 }, "x": 0, "y": 0 }
  ],
  "wires": [
    { "from": { "module": "osc1", "port": "out" }, "to": { "module": "out", "port": "in" } }
  ]
}
\`\`\`

Rules:
- \`id\` is any string unique within the patch; wires reference these ids.
- \`params\` may list only the params you change; everything else gets its default. Values are numbers; for option params use the option's INDEX (0-based).
- A few modules carry a \`data\` object instead of params for their pattern (e.g. \`composer\` holds \`"data": { "notes": [...], "length": 4 }\`, each note \`{ "start": beats, "length": beats, "pitch": midi, "vel": 0..1 }\`).
- \`x\`/\`y\` are layout hints in pixels (module tiles are 160–400 wide); the app auto-layouts to avoid overlap, so rough positions are fine.
- Wire type compatibility: a wire connects an OUT port to an IN port of the SAME signal type (audio→audio, note→note, control→control).
- A CONTROL input accepts at most ONE wire (single fan-in). Audio inputs sum multiple wires. Note outputs may fan out to many inputs.
- Audio must reach an \`audioOut\` module to be heard — include one unless the user says otherwise.
- Tempo-aware modules sync to the Master Transport implicitly; you rarely need a \`transport\` module inside a group.
`;

export const SIGNAL_FLOW = `
## Building instruments from components

There is no single "synth" or "drum" module — you build instruments by wiring
small components. Learn these signal-flow patterns and combine them.

Wire types: notes (cyan), control (magenta, single fan-in), audio (amber, sums).

- **Subtractive synth voice**: \`note source → voice → osc → vcf → vca → audioOut\`.
  The \`voice\` turns a note stream into per-voice \`pitch\` (wire to \`osc.pitch\`) and
  \`gate\` (wire to an \`envelope.gate\`). The amp envelope drives loudness:
  \`envelope.out → vca.cv\`. A second \`envelope.out → vcf.mod\` gives a filter envelope
  (depth = the vcf \`amt\` param, in octaves). \`lfo.out → vcf.mod\` instead for a
  sweep. Set \`voice.voices\` to 1 for a mono/bass patch, higher for polyphony.
- **Two-oscillator / detune**: two \`osc\` both fed \`voice.pitch\`, both \`→ vcf.in\`
  (audio sums). Detune one with its \`fine\` param.
- **FM**: use the \`fmosc\` component (2-op cell: built-in sine modulator → carrier).
  \`Coarse\`/\`Detune\` set the ratio, \`Index\` the depth (wire an envelope to \`idxMod\`
  for evolving brightness), \`Feedback\` adds grit. Chain \`fmosc.out → fmosc.fm\` for
  deeper serial towers.
- **Wavetable**: use \`wtosc\` (Position param + posMod input) in place of \`osc\`.
- **Additive**: use \`addosc\` (sine-partial bank) in place of \`osc\`. \`Partials\` count,
  \`Tilt\` brightness slope, \`Odd\` odd/even balance, \`Inharm\` partial stretch. Wire an
  \`lfo\`/\`envelope\` → \`addosc.tiltMod\` for spectral motion.
- **Pluck / plucked string**: use \`pluck\` — it is self-exciting, NO \`osc\` needed.
  \`voice.pitch → pluck.pitch\` AND \`voice.gate → pluck.gate\` (the gate's rising edge
  fires the string). \`Tone\` = excitation character, \`Pos\` = pluck position, \`Decay\`
  = ring time, \`Stretch\` = inharmonicity. \`pluck.out → vca\`/\`audioOut\`.
- **Resonator (bowed/struck/comb)**: \`resonator\` resonates whatever audio is wired in.
  For a bowed/struck string excite it: \`osc\` (noise wave) → \`vca\` (gated by an
  \`envelope\`) → \`resonator.in\`, with \`voice.pitch → resonator.pitch\`. Feed a drum
  loop or any audio instead for a tuned comb. \`Decay\` = feedback, \`Mix\` = dry/wet.
- **Sampler**: \`note source → smpl → audioOut\`. \`smpl\` has its own amp envelope.
- **Granular**: \`note source → granular → audioOut\` (Source = sample; load a sample,
  held notes transpose the grains). Or Source = live: \`osc\`/\`audioIn\` → \`granular.in\`
  to granulate any signal. \`Size\`/\`Density\`/\`Spray\` shape the cloud; \`pos\` scans.
- **Drum kit**: one \`composer\` (its \`data.notes\` are the beat; each note's \`pitch\`
  selects a drum) fanned out to several \`smpl\`, one per drum. Give each \`smpl\` a
  \`trigNote\` (the pitch that fires it), \`fixedPitch\` = 1 (play at root, ignore
  pitch) and \`voices\` = 1. Hi-hats share a \`chokeGroup\` so open/closed cut each
  other. All \`smpl.out → audioOut.in\`.
- Always end audio at an \`audioOut\`. Effects (delay/reverb/etc.) sit in the audio
  path before it.
`;

/** Face object schema + layout rules — shared by the patch, project, and face-only spec packs. */
export const FACE_ELEMENT_RULES = `
\`\`\`json
"face": {
  "width": 360, "height": 230,
  "elements": [
    { "kind": "label", "x": 16, "y": 4, "text": "FILTER" },
    { "kind": "knob", "x": 16, "y": 28, "label": "Cutoff", "module": "bass", "param": "cutoff" },
    { "kind": "knob", "x": 96, "y": 28, "label": "Res", "module": "bass", "param": "res" },
    { "kind": "meter", "x": 16, "y": 150, "label": "Out", "module": "out" }
  ]
}
\`\`\`

Rules:
- \`kind\` is one of: \`knob\`, \`slider\`, \`button\`, \`readout\` (each binds to a \`module\` + \`param\`);
  \`xy\` (binds two axes: \`module\`/\`param\` for X, \`module2\`/\`param2\` for Y); \`meter\` (binds a
  \`module\` only — show its output level); \`label\` (static text via \`text\`). Do NOT use \`image\`.
- \`module\` is an \`id\` from this patch's \`modules\`; \`param\` is one of that module's param ids.
- \`x\`/\`y\` are pixels from the panel's top-left; \`w\`/\`h\` are optional (sensible defaults per
  kind). Lay controls out on a grid that fits inside \`width\`/\`height\` without overlapping
  (knobs ~70×86, sliders ~36×120, meters ~90×16). Group related controls and add \`label\`
  captions for sections.
- Bindings that don't resolve are dropped with a warning; the rest of the face still loads.
`;

const FACE_RULES = `
## Optional module face (front panel)

You MAY add a top-level \`face\` object to give the patch a designed control panel —
knobs/sliders/etc. wired to inner module params. The patch is collapsed to this
panel when imported, so it reads as one finished instrument. Omit \`face\` for a
plain patch.
${FACE_ELEMENT_RULES}`;

const EXAMPLES = `
## Annotated examples

### 1. Subtractive bass (sequencer → voice → filter)
\`\`\`json
{
  "kind": "kkgroup", "formatVersion": 1, "name": "Subtractive Bass",
  "modules": [
    { "id": "seq", "type": "sequencer", "params": { "division": 2 } },
    { "id": "voice", "type": "voice", "params": { "voices": 1, "glide": 0.04 } },
    { "id": "osc", "type": "osc", "params": { "wave": 3, "octave": -1 } },
    { "id": "ampEnv", "type": "envelope", "params": { "attack": 0.005, "decay": 0.12, "sustain": 0.2, "release": 0.12 } },
    { "id": "filtEnv", "type": "envelope", "params": { "attack": 0.005, "decay": 0.18, "sustain": 0, "release": 0.12 } },
    { "id": "vcf", "type": "vcf", "params": { "cutoff": 500, "res": 0.45, "amt": 2.5 } },
    { "id": "vca", "type": "vca" },
    { "id": "out", "type": "audioOut" }
  ],
  "wires": [
    { "from": { "module": "seq", "port": "notes" }, "to": { "module": "voice", "port": "notes" } },
    { "from": { "module": "voice", "port": "pitch" }, "to": { "module": "osc", "port": "pitch" } },
    { "from": { "module": "voice", "port": "gate" }, "to": { "module": "ampEnv", "port": "gate" } },
    { "from": { "module": "voice", "port": "gate" }, "to": { "module": "filtEnv", "port": "gate" } },
    { "from": { "module": "osc", "port": "out" }, "to": { "module": "vcf", "port": "in" } },
    { "from": { "module": "filtEnv", "port": "out" }, "to": { "module": "vcf", "port": "mod" } },
    { "from": { "module": "vcf", "port": "out" }, "to": { "module": "vca", "port": "in" } },
    { "from": { "module": "ampEnv", "port": "out" }, "to": { "module": "vca", "port": "cv" } },
    { "from": { "module": "vca", "port": "out" }, "to": { "module": "out", "port": "in" } }
  ],
  "face": {
    "width": 360, "height": 200,
    "elements": [
      { "kind": "label", "x": 16, "y": 4, "text": "BASS" },
      { "kind": "knob", "x": 16, "y": 28, "label": "Cutoff", "module": "vcf", "param": "cutoff" },
      { "kind": "knob", "x": 96, "y": 28, "label": "Q", "module": "vcf", "param": "res" },
      { "kind": "knob", "x": 176, "y": 28, "label": "Env Amt", "module": "vcf", "param": "amt" },
      { "kind": "knob", "x": 256, "y": 28, "label": "Decay", "module": "ampEnv", "param": "decay" },
      { "kind": "meter", "x": 16, "y": 150, "w": 320, "label": "Out", "module": "out" }
    ]
  }
}
\`\`\`
One \`voice\` (mono) drives the \`osc\`; the amp \`envelope\` shapes the \`vca\`, a second
\`envelope\` sweeps the \`vcf\` cutoff. This is the core subtractive recipe.

### 2. FM pad (fmosc)
\`\`\`json
{
  "kind": "kkgroup", "formatVersion": 1, "name": "FM Pad",
  "modules": [
    { "id": "kb", "type": "keyboard" },
    { "id": "voice", "type": "voice", "params": { "voices": 8, "glide": 0 } },
    { "id": "fm", "type": "fmosc", "params": { "coarse": 2, "index": 3, "feedback": 0.1 } },
    { "id": "env", "type": "envelope", "params": { "attack": 0.8, "decay": 0.5, "sustain": 0.7, "release": 2.5 } },
    { "id": "ienv", "type": "envelope", "params": { "attack": 0.01, "decay": 1.5, "sustain": 0.2, "release": 1.5 } },
    { "id": "vca", "type": "vca" },
    { "id": "verb", "type": "reverb", "params": { "algo": 1, "decay": 0.8, "mix": 0.45 } },
    { "id": "out", "type": "audioOut" }
  ],
  "wires": [
    { "from": { "module": "kb", "port": "notes" }, "to": { "module": "voice", "port": "notes" } },
    { "from": { "module": "voice", "port": "pitch" }, "to": { "module": "fm", "port": "pitch" } },
    { "from": { "module": "voice", "port": "gate" }, "to": { "module": "env", "port": "gate" } },
    { "from": { "module": "voice", "port": "gate" }, "to": { "module": "ienv", "port": "gate" } },
    { "from": { "module": "ienv", "port": "out" }, "to": { "module": "fm", "port": "idxMod" } },
    { "from": { "module": "fm", "port": "out" }, "to": { "module": "vca", "port": "in" } },
    { "from": { "module": "env", "port": "out" }, "to": { "module": "vca", "port": "cv" } },
    { "from": { "module": "vca", "port": "out" }, "to": { "module": "verb", "port": "in" } },
    { "from": { "module": "verb", "port": "out" }, "to": { "module": "out", "port": "in" } }
  ]
}
\`\`\`
The \`fmosc\` is a self-contained 2-op FM cell (built-in sine modulator → carrier).
\`coarse\`/\`detune\` set the ratio, \`index\` the depth; a second envelope into \`idxMod\`
gives the classic FM brightness-decay. Chain \`fmosc.out → fmosc.fm\` for deeper towers.
Polyphonic via an 8-voice \`voice\`.

### 3. Drum kit (composer → sample voices)
\`\`\`json
{
  "kind": "kkgroup", "formatVersion": 1, "name": "Drum Kit",
  "modules": [
    { "id": "beat", "type": "composer", "data": { "length": 4, "notes": [
      { "start": 0, "length": 0.1, "pitch": 36, "vel": 0.9 },
      { "start": 1, "length": 0.1, "pitch": 36, "vel": 0.9 },
      { "start": 2, "length": 0.1, "pitch": 36, "vel": 0.9 },
      { "start": 3, "length": 0.1, "pitch": 36, "vel": 0.9 },
      { "start": 1, "length": 0.1, "pitch": 37, "vel": 0.8 },
      { "start": 3, "length": 0.1, "pitch": 37, "vel": 0.8 },
      { "start": 0, "length": 0.1, "pitch": 40, "vel": 0.6 },
      { "start": 0.5, "length": 0.1, "pitch": 40, "vel": 0.5 },
      { "start": 1, "length": 0.1, "pitch": 40, "vel": 0.6 },
      { "start": 1.5, "length": 0.1, "pitch": 40, "vel": 0.5 },
      { "start": 2, "length": 0.1, "pitch": 40, "vel": 0.6 },
      { "start": 2.5, "length": 0.1, "pitch": 40, "vel": 0.5 },
      { "start": 3, "length": 0.1, "pitch": 40, "vel": 0.6 },
      { "start": 3.5, "length": 0.1, "pitch": 40, "vel": 0.5 }
    ] } },
    { "id": "kick", "type": "smpl", "params": { "trigNote": 36, "fixedPitch": 1, "voices": 1 } },
    { "id": "snare", "type": "smpl", "params": { "trigNote": 37, "fixedPitch": 1, "voices": 1 } },
    { "id": "hat", "type": "smpl", "params": { "trigNote": 40, "fixedPitch": 1, "voices": 1, "chokeGroup": 1 } },
    { "id": "out", "type": "audioOut" }
  ],
  "wires": [
    { "from": { "module": "beat", "port": "notes" }, "to": { "module": "kick", "port": "notes" } },
    { "from": { "module": "beat", "port": "notes" }, "to": { "module": "snare", "port": "notes" } },
    { "from": { "module": "beat", "port": "notes" }, "to": { "module": "hat", "port": "notes" } },
    { "from": { "module": "kick", "port": "out" }, "to": { "module": "out", "port": "in" } },
    { "from": { "module": "snare", "port": "out" }, "to": { "module": "out", "port": "in" } },
    { "from": { "module": "hat", "port": "out" }, "to": { "module": "out", "port": "in" } }
  ]
}
\`\`\`
The \`composer\` clip is the beat: each note's pitch picks a drum (36=kick, 37=snare,
40=hat). One note bus fans out to three \`smpl\` voices, each firing only on its
\`trigNote\`. The user loads samples onto each voice; the kit ships with defaults.
`;

/** Module catalog section, generated from the live registry (shared with the project spec). */
export function moduleCatalogSection(): string {
  const lines: string[] = [];
  lines.push('## Module catalog');
  lines.push('');
  for (const def of MODULE_DEFS.values()) {
    lines.push(`### ${def.type} — ${def.name}`);
    lines.push(def.description);
    const ports = def.ports
      .map((p) => `\`${p.id}\` (${p.type} ${p.direction})`)
      .join(', ');
    lines.push(`Ports: ${ports || 'none'}`);
    if (def.params.length > 0) {
      lines.push('Params:');
      for (const p of def.params) {
        const opts = p.options ? ` options: [${p.options.map((o, i) => `${i}=${o}`).join(', ')}]` : '';
        const unit = p.unit ? ` ${p.unit}` : '';
        lines.push(`- \`${p.id}\` (${p.min}–${p.max}${unit}, default ${p.default})${opts}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function generateSpecPack(): string {
  const lines: string[] = [];
  lines.push('# KabelKraft AI patch spec');
  lines.push('');
  lines.push(
    'You are writing a patch for KabelKraft, a modular audio playground. ' +
      'Modules are connected with typed wires. Produce a single JSON code block in the format below.',
  );
  lines.push(FORMAT_RULES);
  lines.push(SIGNAL_FLOW);
  lines.push(moduleCatalogSection());
  lines.push(FACE_RULES);
  lines.push(EXAMPLES);
  return lines.join('\n');
}
