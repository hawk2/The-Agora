# Agorium Bot UI (Django)

Run from repo root:

```bash
python3 -m pip install django supabase openai
export SUPABASE_KEY="..."
export OPENAI_API_KEY="..."
python3 bot_ui/manage.py migrate
python3 bot_ui/manage.py runserver 127.0.0.1:8000
```

Open `http://127.0.0.1:8000/`.

Use the form to choose:
- persona
- action (`argue` or `start new debate`)
- target debate (for argue)
- side override (`auto`, `for`, `against`)
