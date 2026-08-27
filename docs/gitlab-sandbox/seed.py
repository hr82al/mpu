"""Посев песочницы GitLab: проект, ветка, коммиты, MR — и env-файл для `mpu`.

Запускается после того, как контейнер `mpu-gitlab-sandbox` ответил 200 на
`/users/sign_in`. Токен создаётся заранее через `gitlab-rails runner` и
передаётся аргументом: сюда он приходит уже готовым, чтобы скрипт не знал
ничего о внутренностях контейнера.

    python3 seed.py <token>

Результат печатается одной строкой JSON: путь проекта, iid MR и файл,
изменённый в диффе (на него потом вешается инлайн-комментарий).
"""

import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8929"
PROJECT = "mpu-sandbox"
BRANCH = "feat/sandbox/change"


def call(method: str, path: str, token: str, data: dict[str, object] | None = None):
    body = urllib.parse.urlencode(data, doseq=True).encode() if data else None
    req = urllib.request.Request(
        f"{BASE}/api/v4{path}",
        data=body,
        method=method,
        headers={"PRIVATE-TOKEN": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        detail = err.read().decode()[:400]
        raise SystemExit(f"{method} {path} -> {err.code}: {detail}") from None


def main() -> None:
    token = sys.argv[1]

    projects = call("GET", "/projects?owned=true&per_page=100", token)
    project = next((p for p in projects if p["path"] == PROJECT), None)
    if project is None:
        project = call("POST", "/projects", token, {
            "name": PROJECT, "path": PROJECT, "visibility": "private",
            "initialize_with_readme": "true", "default_branch": "main",
        })
    pid = project["id"]

    # Файл в main — чтобы у ветки был осмысленный дифф, а не пустое добавление.
    content = "\n".join(f"строка {i}" for i in range(1, 21)) + "\n"
    exists = True
    try:
        call("GET", f"/projects/{pid}/repository/files/src%2Fmodule.txt?ref=main", token)
    except SystemExit:
        exists = False
    if not exists:
        call("POST", f"/projects/{pid}/repository/files/src%2Fmodule.txt", token, {
            "branch": "main", "content": content,
            "commit_message": "chore(sandbox): исходный файл под дифф",
        })

    branches = call("GET", f"/projects/{pid}/repository/branches", token)
    if not any(b["name"] == BRANCH for b in branches):
        call("POST", f"/projects/{pid}/repository/branches", token,
             {"branch": BRANCH, "ref": "main"})
        changed = content.replace("строка 7", "строка 7 — изменена")
        call("PUT", f"/projects/{pid}/repository/files/src%2Fmodule.txt", token, {
            "branch": BRANCH, "content": changed,
            "commit_message": "feat(sandbox): правка седьмой строки",
        })

    mrs = call("GET", f"/projects/{pid}/merge_requests?state=opened", token)
    mr = next((m for m in mrs if m["source_branch"] == BRANCH), None)
    if mr is None:
        mr = call("POST", f"/projects/{pid}/merge_requests", token, {
            "source_branch": BRANCH, "target_branch": "main",
            "title": "feat(sandbox): правка седьмой строки",
            "description": "MR песочницы: на нём снимается пара по записи.",
        })

    print(json.dumps({
        "project": project["path_with_namespace"],
        "mr_iid": mr["iid"],
        "file": "src/module.txt",
        "web_url": mr["web_url"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
