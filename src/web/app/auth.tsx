import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
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
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
} from '../ui/dropdown-menu';
import { APPEARANCE_MODES, DEFAULT_SKIN_ID, SKINS } from '@shared/appearance';
import { workspaceStore } from './store';
import {
  APPEARANCE_LABELS,
  applyMode,
  applySkin,
  chooseMode,
  chooseSkin,
} from './appearance';
import { toast } from '../ui/toast';
import { authErrorMessage } from './auth-errors';
const authClient = createAuthClient({ plugins: [passkeyClient()] });
// «Войти через хаб» (src/server/hub-signin.ts): after a failed attempt the
// server comes back to `/?hub_signin=<reason>`. Read once per page load and
// taken out of the address, so a reload does not repeat it.
const HUB_NOTICES: Record<string, string> = {
  expired:
    'Вход через хаб не завершён: ссылка устарела или уже использована. Попробуйте ещё раз.',
  state: 'Вход через хаб начат в другом окне или устарел. Начните заново.',
  unavailable: 'Хаб сейчас не отвечает. Попробуйте позже или войдите паролем.',
  held: 'TaskIndex обновляется. Попробуйте войти через минуту.',
  error: 'Не удалось открыть сессию. Попробуйте ещё раз.',
};
const hubNoticeAtLoad = (() => {
  const params = new URLSearchParams(location.search);
  const reason = params.get('hub_signin');
  if (reason === null) return null;
  params.delete('hub_signin');
  const rest = params.toString();
  history.replaceState(
    history.state,
    '',
    `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`,
  );
  return reason;
})();
function useHubSignin() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch('/auth/hub/available', { cache: 'no-store' });
        const body: { available?: boolean } = r.ok ? await r.json() : {};
        if (alive) setAvailable(body.available === true);
      } catch {
        // No answer: the password sign-in alone, as before.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return available;
}
const goToHub = () =>
  location.assign(
    `/auth/hub?next=${encodeURIComponent(location.pathname + location.search)}`,
  );
function OwnerOnly({ onBack }: { onBack: () => void }) {
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand">
          <PanelsTopLeft />
          <strong>TaskIndex</strong>
        </div>
        <h1>Это место владельца</h1>
        <p>
          В хабе вы вошли не как владелец агентства. TaskIndex открывается
          только владельцу.
        </p>
        <Button variant="outline" onClick={onBack}>
          Ко входу
        </Button>
      </section>
    </main>
  );
}
export function AuthGate({ children }: { children: ReactNode }) {
  const session = authClient.useSession();
  const hub = useHubSignin();
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(
      hubNoticeAtLoad ? (HUB_NOTICES[hubNoticeAtLoad] ?? '') : '',
    ),
    [ownerOnly, setOwnerOnly] = useState(hubNoticeAtLoad === 'not_owner');
  if (session.isPending)
    return <output className="auth-screen">Открываем TaskIndex…</output>;
  if (session.data) return children;
  if (ownerOnly) return <OwnerOnly onBack={() => setOwnerOnly(false)} />;
  async function signIn(passkey = false) {
    setBusy(true);
    setError('');
    try {
      const result = passkey
        ? await authClient.signIn.passkey()
        : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(
          authErrorMessage(result.error, passkey ? 'passkey' : 'signIn'),
        );
        return;
      }
      await session.refetch();
    } catch (error_) {
      setError(authErrorMessage(error_, passkey ? 'passkey' : 'signIn'));
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
        {hub && (
          <>
            <Button disabled={busy} onClick={goToHub}>
              Войти через хаб
            </Button>
            <p className="auth-divider">или паролем</p>
          </>
        )}
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
          <Button
            type="submit"
            variant={hub ? 'outline' : 'default'}
            disabled={busy}
          >
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
  // The workspace record is the truth; the local cache only survives a reload.
  const { data } = useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
  );
  const mode = data.appearance[0]?.mode ?? 'system';
  const skinId = data.appearance[0]?.skinId ?? DEFAULT_SKIN_ID;
  useEffect(() => applyMode(mode), [mode]);
  useEffect(() => applySkin(skinId), [skinId]);
  const report = (e: unknown) =>
    toast.add({
      title: e instanceof Error ? e.message : 'Не удалось сохранить.',
      type: 'error',
    });
  async function addPasskey() {
    try {
      const result = await authClient.passkey.addPasskey({ name: 'TaskIndex' });
      if (result.error) {
        toast.add({
          title: authErrorMessage(result.error, 'addPasskey'),
          type: 'error',
        });
        return;
      }
      toast.add({ title: 'Passkey добавлен', type: 'success' });
    } catch (error_) {
      toast.add({
        title: authErrorMessage(error_, 'addPasskey'),
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
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Оформление</DropdownMenuLabel>
          {APPEARANCE_MODES.map((value) => (
            <DropdownMenuItem
              key={value}
              data-active={mode === value ? '' : undefined}
              onClick={() => void chooseMode(value).catch(report)}
            >
              {APPEARANCE_LABELS[value]}
              {mode === value && ' ·'}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Скин</DropdownMenuLabel>
          {/* TI-026: каталог с карточкой предпросмотра — четыре цвета из
              реестра, сама палитра живёт в tokens.css. */}
          {SKINS.map((skin) => (
            <DropdownMenuItem
              key={skin.id}
              className="skin-choice"
              data-active={skinId === skin.id ? '' : undefined}
              onClick={() => void chooseSkin(skin.id).catch(report)}
            >
              <span
                className="skin-preview"
                aria-hidden="true"
                style={{
                  background: skin.preview.background,
                  borderColor: skin.preview.foreground,
                }}
              >
                <span
                  className="skin-preview-card"
                  style={{
                    background: skin.preview.surface,
                    borderColor: skin.preview.foreground,
                  }}
                >
                  <span style={{ background: skin.preview.foreground }} />
                  <span style={{ background: skin.preview.accent }} />
                </span>
              </span>
              <span className="skin-text">
                <span className="skin-name">
                  {skin.label}
                  {skinId === skin.id && ' ·'}
                </span>
                <span className="skin-description">{skin.description}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
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
