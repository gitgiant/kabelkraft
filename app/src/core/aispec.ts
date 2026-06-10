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
    { "id": "a", "type": "synth", "params": { "mode": 2, "level": 0.7 }, "x": 0, "y": 0 }
  ],
  "wires": [
    { "from": { "module": "a", "port": "out" }, "to": { "module": "b", "port": "in" } }
  ]
}
\`\`\`

Rules:
- \`id\` is any string unique within the patch; wires reference these ids.
- \`params\` may list only the params you change; everything else gets its default. Values are numbers; for option params use the option's INDEX (0-based).
- \`x\`/\`y\` are layout hints in pixels (module tiles are 160–400 wide); the app auto-layouts to avoid overlap, so rough positions are fine.
- Wire type compatibility: a wire connects an OUT port to an IN port of the SAME signal type (audio→audio, note→note, control→control).
- A CONTROL input accepts at most ONE wire (single fan-in). Audio inputs sum multiple wires. Note outputs may fan out to many inputs.
- Audio must reach an \`audioOut\` module to be heard — include one unless the user says otherwise.
- Tempo-aware modules sync to the Master Transport implicitly; you rarely need a \`transport\` module inside a group.
`;

const EXAMPLES = `
## Annotated examples

### 1. Moody bass with sidechain pumping
\`\`\`json
{
  "kind": "kkgroup", "formatVersion": 1, "name": "Sidechain Bass",
  "modules": [
    { "id": "seq", "type": "sequencer", "params": { "division": 1 } },
    { "id": "bass", "type": "synth", "params": { "waveform": 3, "octave": -2, "fType": 1, "cutoff": 600, "res": 0.5 } },
    { "id": "kick", "type": "drum" },
    { "id": "comp", "type": "compressor", "params": { "threshold": -35, "ratio": 8, "release": 180 } },
    { "id": "out", "type": "audioOut" }
  ],
  "wires": [
    { "from": { "module": "seq", "port": "notes" }, "to": { "module": "bass", "port": "notes" } },
    { "from": { "module": "bass", "port": "out" }, "to": { "module": "comp", "port": "in" } },
    { "from": { "module": "kick", "port": "out" }, "to": { "module": "comp", "port": "sc" } },
    { "from": { "module": "kick", "port": "out" }, "to": { "module": "out", "port": "in" } },
    { "from": { "module": "comp", "port": "out" }, "to": { "module": "out", "port": "in" } }
  ]
}
\`\`\`
The kick drives the compressor's sidechain input, so the bass ducks on every hit.

### 2. Evolving FM pad
\`\`\`json
{
  "kind": "kkgroup", "formatVersion": 1, "name": "FM Pad",
  "modules": [
    { "id": "kb", "type": "keyboard" },
    { "id": "pad", "type": "synth", "params": { "mode": 2, "algo": 3, "l2": 0.4, "r2": 3.01, "attack": 0.8, "release": 2.5, "voices": 8 } },
    { "id": "lfo", "type": "lfo", "params": { "rate": 0.15, "depth": 0.6 } },
    { "id": "verb", "type": "reverb", "params": { "algo": 1, "decay": 0.8, "mix": 0.45 } },
    { "id": "out", "type": "audioOut" }
  ],
  "wires": [
    { "from": { "module": "kb", "port": "notes" }, "to": { "module": "pad", "port": "notes" } },
    { "from": { "module": "lfo", "port": "out" }, "to": { "module": "pad", "port": "posMod" } },
    { "from": { "module": "pad", "port": "out" }, "to": { "module": "verb", "port": "in" } },
    { "from": { "module": "verb", "port": "out" }, "to": { "module": "out", "port": "in" } }
  ]
}
\`\`\`
The LFO on posMod slowly sweeps FM modulation depth; hall reverb glues it.

### 3. Generative bleeps
\`\`\`json
{
  "kind": "kkgroup", "formatVersion": 1, "name": "Random Bleeps",
  "modules": [
    { "id": "seq", "type": "sequencer", "params": { "division": 2, "gate": 0.2 } },
    { "id": "arpx", "type": "arp", "params": { "mode": 3, "octaves": 3, "division": 3 } },
    { "id": "blip", "type": "synth", "params": { "waveform": 0, "decay": 0.08, "sustain": 0 } },
    { "id": "dly", "type": "delay", "params": { "sync": 2, "pingpong": 1, "feedback": 0.55, "mix": 0.4 } },
    { "id": "out", "type": "audioOut" }
  ],
  "wires": [
    { "from": { "module": "seq", "port": "notes" }, "to": { "module": "arpx", "port": "notes" } },
    { "from": { "module": "arpx", "port": "out" }, "to": { "module": "blip", "port": "notes" } },
    { "from": { "module": "blip", "port": "out" }, "to": { "module": "dly", "port": "in" } },
    { "from": { "module": "dly", "port": "out" }, "to": { "module": "out", "port": "in" } }
  ]
}
\`\`\`
Sequencer gates feed a random-mode arpeggiator into a plucky sine through synced ping-pong delay.
`;

export function generateSpecPack(): string {
  const lines: string[] = [];
  lines.push('# KabelKraft AI patch spec');
  lines.push('');
  lines.push(
    'You are writing a patch for KabelKraft, a modular audio playground. ' +
      'Modules are connected with typed wires. Produce a single JSON code block in the format below.',
  );
  lines.push(FORMAT_RULES);
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
  lines.push(EXAMPLES);
  return lines.join('\n');
}
