const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const rememberInput = document.getElementById('remember');
const errorBox = document.getElementById('loginError');
const submitButton = document.getElementById('submitLogin');
const togglePassword = document.getElementById('togglePassword');

function destination() {
  const requested = new URLSearchParams(window.location.search).get('next') || '/';
  return requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector('span').textContent = loading ? 'Signing in…' : 'Sign in';
}

try {
  usernameInput.value = localStorage.getItem('dabcast_last_user') || '';
} catch { /* storage can be disabled */ }

togglePassword.addEventListener('click', () => {
  const show = passwordInput.type === 'password';
  passwordInput.type = show ? 'text' : 'password';
  togglePassword.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  togglePassword.title = show ? 'Hide password' : 'Show password';
  passwordInput.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  setLoading(true);

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: usernameInput.value.trim(),
        password: passwordInput.value,
        remember: rememberInput.checked
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Login failed (HTTP ${response.status})`);

    try { localStorage.setItem('dabcast_last_user', usernameInput.value.trim()); } catch { /* ignore */ }
    window.location.replace(destination());
  } catch (error) {
    showError(error.message || String(error));
    passwordInput.select();
  } finally {
    setLoading(false);
  }
});

fetch('/api/auth/session')
  .then((response) => response.ok ? response.json() : null)
  .then((session) => {
    if (session?.authenticated) window.location.replace(destination());
  })
  .catch(() => {});
