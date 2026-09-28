import { parentPort, workerData } from 'node:worker_threads';
import { closeDatabase, openDatabase } from '../../src/database/index.ts';
import {
  UserAdminMutationError,
  userRepo,
} from '../../src/database/repositories/user.ts';

interface WorkerInput {
  dataDir: string;
  userId: number;
  actorId: number;
}

const port = parentPort;
if (!port) throw new Error('admin-mutation-worker requires a parent port');
const input = workerData as WorkerInput;
openDatabase(input.dataDir);
port.postMessage({ type: 'ready' });

port.once('message', () => {
  let result: { ok: true } | { ok: false; code: string; message: string };
  try {
    userRepo.updateByAdministrator(input.userId, { role: 'viewer' }, input.actorId);
    result = { ok: true };
  } catch (error) {
    result = {
      ok: false,
      code: error instanceof UserAdminMutationError ? error.code : 'unexpected_error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    closeDatabase();
  }
  port.postMessage(result);
  port.close();
});
