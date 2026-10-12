import { parentPort, workerData } from 'node:worker_threads';
import { closeDatabase, openDatabase } from '../../src/database/index.ts';
import { statisticsRepo } from '../../src/database/repositories/statistics.ts';

interface WorkerInput {
  dataDir: string;
  groupId: string;
  calls: number;
}

const port = parentPort;
if (!port) throw new Error('statistics-worker requires a parent port');
const input = workerData as WorkerInput;
openDatabase(input.dataDir);
port.postMessage({ type: 'ready' });

port.once('message', () => {
  try {
    for (let index = 0; index < input.calls; index += 1) {
      statisticsRepo.bump(input.groupId, 'approvals_total');
    }
    port.postMessage({ type: 'done', ok: true });
  } catch (error) {
    port.postMessage({
      type: 'done',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    closeDatabase();
    port.close();
  }
});
