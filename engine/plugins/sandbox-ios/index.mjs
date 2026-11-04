// ctx.sandbox for iOS. There is no OS-level runner (no Seatbelt, bwrap or
// Landlock) inside an app, but our commands never leave the just-bash
// interpreter, so the interpreter's filesystem is the fence: confine() prefixes
// the argv with a marker naming the writable roots, and subprocess-ios runs
// the command over a read-only view of the filesystem with only those roots
// mounted writable. Enforcement is "partial": file effects are fenced, network
// is not, and `node` (a worker thread) runs outside the interpreter.
import { SandboxProvider, writableRoots } from '@deepseek-ai/dsh-sandbox';

export const CONFINE = '/bin/dsh-ios-confine';

export class IosSandboxProvider extends SandboxProvider {
  async confine(argv, policy) {
    const roots = writableRoots(policy);
    return {
      argv: [CONFINE, ...roots.flatMap((root) => ['--write', root]), '--', ...argv],
      enforcement: 'partial',
      denialSignatures: ['EROFS: read-only file system'],
      runnerFailureRules: [],
    };
  }
}

export default IosSandboxProvider;
