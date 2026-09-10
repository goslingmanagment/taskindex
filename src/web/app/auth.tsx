import { useState, type ReactNode } from 'react';
import { createAuthClient } from 'better-auth/react';
import { passkeyClient } from '@better-auth/passkey/client';
import { PanelsTopLeft, KeyRound } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu';
import { toast } from '../ui/toast';
export const authClient = createAuthClient({ plugins: [passkeyClient()] });
export function AuthGate({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (session.isPending)
    return <output className="auth-screen">Открываем TaskIndex…</output>;
  if (session.data) return children;
  async function signIn(passkey = false) {
    setBusy(true);
    setError('');
    try {
      const result = passkey
        ? await authClient.signIn.passkey()
        : await authClient.signIn.email({ email, password });
      if (result.error)
        throw new Error(result.error.message || 'Не удалось войти.');
      await session.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось войти.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand">
          <PanelsTopLeft />
          <strong>TaskIndex</strong>
        </div>
        <h1>Войти в пространство</h1>
        <p>Агентство, разработка и личное.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void signIn();
          }}
        >
          <label htmlFor="login-email">
            Почта
            <Input
              id="login-email"
              type="email"
              autoComplete="username webauthn"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>
          <label htmlFor="login-password">
            Пароль
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </label>
          {(error || session.error) && (
            <p role="alert" className="form-error">
              {error || 'Не удалось проверить сессию. Попробуйте ещё раз.'}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? 'Входим…' : 'Войти'}
          </Button>
        </form>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void signIn(true)}
        >
          <KeyRound />
          Войти с passkey
        </Button>
      </section>
    </main>
  );
}
export function AccountMenu() {
  const session = authClient.useSession();
  async function addPasskey() {
    try {
      const result = await authClient.passkey.addPasskey({ name: 'TaskIndex' });
      if (result.error)
        throw new Error(result.error.message || 'Не удалось добавить passkey.');
      toast.add({ title: 'Passkey добавлен', type: 'success' });
    } catch (e) {
      toast.add({
        title: e instanceof Error ? e.message : 'Не удалось добавить passkey.',
        type: 'error',
      });
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="account-button">
        {session.data?.user.name || 'Владелец'}
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={() => void addPasskey()}>
          Добавить passkey
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            void authClient.signOut().then(() => location.reload())
          }
        >
          Выйти
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
