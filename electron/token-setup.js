const token = document.getElementById('token');
const save = document.getElementById('save');
const skip = document.getElementById('skip');
const status = document.getElementById('status');

async function submit() {
  save.disabled = true;
  skip.disabled = true;
  status.textContent = 'Saving securely and starting the local API…';
  const result = await window.bessforgeTokenSetup.save(token.value);
  if (!result?.ok) {
    status.textContent = result?.message || 'The token could not be saved.';
    save.disabled = false;
    skip.disabled = false;
    token.focus();
  }
}

save.addEventListener('click', submit);
skip.addEventListener('click', () => window.bessforgeTokenSetup.skip());
token.addEventListener('keydown', event => {
  if (event.key === 'Enter') submit();
});