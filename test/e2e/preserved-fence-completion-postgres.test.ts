import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../preserved-fence-completion.test.ts'));
