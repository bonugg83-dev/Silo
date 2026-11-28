// e2e용 가짜 Firebase (로그인 + 저장소 REST 일부). context.route 로 googleapis 주소를 가로챈다.
// 진짜 서버 규칙처럼 가입 코드가 맞아야 계정 문서를 만들 수 있다.
// saved: 앞에서 dump() 한 값 (데스크톱 앱을 껐다 켜도 계정이 남게)
export function fakeFirebase(code = 'TESTCODE', saved = null) {
  const users = new Map(saved?.users || []); // email -> {uid, password}
  const docs = new Map(saved?.docs || []); // path -> fields
  const tokens = new Map(saved?.tokens || []); // token -> uid
  let n = saved?.n || 0;
  const state = { offline: false, users, docs };
  const issue = (uid) => { const t = `tok${++n}`; tokens.set(t, uid); return { localId: uid, idToken: t, refreshToken: `r${t}`, expiresIn: '3600' }; };
  const err = (status, message, st) => ({ status, body: { error: { code: status, message, status: st || 'INVALID_ARGUMENT' } } });
  const val = (v) => (!v ? 0 : ('integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 0));
  function handle(url, method, body, auth) {
    const u = new URL(url);
    const uidOf = () => tokens.get((auth || '').replace('Bearer ', ''));
    if (u.host === 'identitytoolkit.googleapis.com') {
      const op = u.pathname.split(':')[1];
      if (op === 'signUp') {
        if (users.has(body.email)) return err(400, 'EMAIL_EXISTS');
        const uid = `U${++n}`;
        users.set(body.email, { uid, password: body.password });
        return { status: 200, body: issue(uid) };
      }
      if (op === 'signInWithPassword') {
        const x = users.get(body.email);
        if (!x || x.password !== body.password) return err(400, 'INVALID_LOGIN_CREDENTIALS');
        return { status: 200, body: issue(x.uid) };
      }
      const uid = tokens.get(body.idToken);
      if (!uid) return err(400, 'INVALID_ID_TOKEN');
      const email = [...users].find(([, x]) => x.uid === uid)?.[0];
      if (op === 'delete') { users.delete(email); return { status: 200, body: {} }; }
      if (op === 'update') {
        const x = users.get(email);
        if (body.password) x.password = body.password;
        if (body.displayName !== undefined) x.displayName = body.displayName;
        return { status: 200, body: body.returnSecureToken === false ? { localId: uid, displayName: x.displayName } : issue(uid) };
      }
    }
    if (u.host === 'securetoken.googleapis.com') {
      const t = new URLSearchParams(body).get('refresh_token').slice(1);
      const r = issue(tokens.get(t));
      return { status: 200, body: { user_id: r.localId, id_token: r.idToken, refresh_token: r.refreshToken, expires_in: '3600' } };
    }
    if (u.host === 'firestore.googleapis.com') {
      const uid = uidOf();
      const deny = err(403, 'Missing or insufficient permissions.', 'PERMISSION_DENIED');
      const p = decodeURIComponent(u.pathname).split('/documents')[1] || '';
      if (p === ':commit') {
        for (const w of body.writes) {
          if (w.update) {
            // 모두의 피드백: 로그인한 회원만, text·type·count 만
            const path = w.update.name.split('/documents')[1];
            if (!path.startsWith('/feedback/') || !docs.has(`/users/${uid}`)) return deny;
            const f = { ...(docs.get(path) || {}), ...w.update.fields };
            for (const t of w.updateTransforms || []) f[t.fieldPath] = { integerValue: String(val(f[t.fieldPath]) + val(t.increment)) };
            docs.set(path, f);
            continue;
          }
          const path = w.transform.document.split('/documents')[1];
          if (!path.startsWith(`/users/${uid}/`)) return deny;
          const f = docs.get(path) || {};
          for (const t of w.transform.fieldTransforms) f[t.fieldPath] = { doubleValue: val(f[t.fieldPath]) + val(t.increment) };
          docs.set(path, f);
        }
        return { status: 200, body: {} };
      }
      if (p === '/users' && method === 'POST') {
        const id = u.searchParams.get('documentId');
        if (id !== uid || body.fields.signupCode?.stringValue !== code) return deny;
        docs.set(`/users/${id}`, body.fields);
        return { status: 200, body: { fields: body.fields } };
      }
      if (p === '/feedback' && method === 'GET') {
        if (!docs.has(`/users/${uid}`)) return deny;
        return { status: 200, body: { documents: [...docs].filter(([k]) => k.startsWith('/feedback/')).map(([k, fields]) => ({ name: k, fields })) } };
      }
      if (!p.startsWith(`/users/${uid}`)) return deny;
      if (method === 'GET') return docs.has(p) ? { status: 200, body: { fields: docs.get(p) } } : err(404, 'not found', 'NOT_FOUND');
      if (method === 'PATCH') { docs.set(p, { ...(docs.get(p) || {}), ...body.fields }); return { status: 200, body: {} }; }
      if (method === 'DELETE') { docs.delete(p); return { status: 200, body: {} }; }
    }
    return err(404, 'unknown', 'NOT_FOUND');
  }
  state.handle = handle;
  state.dump = () => ({ users: [...users], docs: [...docs], tokens: [...tokens], n });
  state.install = (context) => context.route(/https:\/\/(identitytoolkit|securetoken|firestore)\.googleapis\.com\//, async (route) => {
    if (state.offline) return route.abort('internetdisconnected');
    const req = route.request();
    const raw = req.postData() || '';
    let body = raw;
    try { body = JSON.parse(raw); } catch { /* form */ }
    const r = handle(req.url(), req.method(), body, req.headers().authorization);
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  return state;
}
