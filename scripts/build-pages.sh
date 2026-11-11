#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="${repo_root}/dist"

if [[ ! -f "${repo_root}/index.html" || ! -f "${repo_root}/_headers" ]]; then
  printf 'Pages source files are missing from %s\n' "${repo_root}" >&2
  exit 1
fi

for source_dir in assets css js; do
  if [[ ! -d "${repo_root}/${source_dir}" ]]; then
    printf 'Required Pages source directory is missing: %s\n' "${source_dir}" >&2
    exit 1
  fi
done

if [[ ! -f "${repo_root}/functions/api/[[path]].js" ]]; then
  printf 'Required Pages Function is missing: functions/api/[[path]].js\n' >&2
  exit 1
fi

if [[ ! -f "${repo_root}/js/runtime-config.js" ]]; then
  printf 'Missing frontend runtime configuration: js/runtime-config.js\n' >&2
  exit 1
fi

if [[ -L "${dist_dir}" ]]; then
  printf 'Refusing to replace a symlink at %s\n' "${dist_dir}" >&2
  exit 1
fi

rm -rf -- "${dist_dir}"
mkdir -p -- "${dist_dir}"
cp -- "${repo_root}/index.html" "${repo_root}/_headers" "${dist_dir}/"
cp -R -- "${repo_root}/assets" "${repo_root}/css" "${repo_root}/js" "${dist_dir}/"

if ! grep -Fq "connect-src 'self' https://*.supabase.co https://*.trycloudflare.com" "${dist_dir}/_headers"; then
  printf 'Pages CSP must allow Supabase and the configured Quick Tunnel API.\n' >&2
  exit 1
fi

runtime_script_line="$(grep -nF '<script src="js/runtime-config.js"></script>' "${dist_dir}/index.html" | cut -d: -f1)"
config_script_line="$(grep -nF '<script src="js/config.js"></script>' "${dist_dir}/index.html" | cut -d: -f1)"
if [[ -z "${runtime_script_line}" || -z "${config_script_line}" || "${runtime_script_line}" -ge "${config_script_line}" ]]; then
  printf 'index.html must load js/runtime-config.js before js/config.js\n' >&2
  exit 1
fi

for path in \
  index.html \
  _headers \
  assets/logo.svg \
  css/style.css \
  js/runtime-config.js \
  js/config.js \
  js/supabase.js \
  js/auth.js \
  js/storage.js \
  js/ui.js \
  js/api.js \
  js/chat.js \
  js/app.js; do
  if [[ ! -f "${dist_dir}/${path}" ]]; then
    printf 'Pages build is missing required file: %s\n' "${path}" >&2
    exit 1
  fi
done

if grep -R -F 'drives-favors-quantity-correctly.trycloudflare.com' "${dist_dir}"; then
  printf 'The expired backend URL is present in the Pages build.\n' >&2
  exit 1
fi

for forbidden in backend venv .env .env.example logs deployment tests supabase .git functions; do
  if [[ -e "${dist_dir}/${forbidden}" ]]; then
    printf 'Unexpected non-frontend content in Pages build: %s\n' "${forbidden}" >&2
    exit 1
  fi
done

printf 'Cloudflare Pages assets created and verified: %s\n' "${dist_dir}"
printf 'Pages Function source remains at the repository root: functions/api/[[path]].js\n'
