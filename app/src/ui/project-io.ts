/** Save the current project as a .kkproj download (Toolbar + Options share this). */

import { appState } from '../state';

export function downloadProject(): void {
  const blob = new Blob([appState.serializeWithSamples()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${appState.projectName}.kkproj`;
  a.click();
  URL.revokeObjectURL(a.href);
}
