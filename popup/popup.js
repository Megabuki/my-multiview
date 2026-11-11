/**
 * My MultiView - 팝업 스크립트
 *  - 채널 입력 및 인식, 드래그 순서 변경, 생방송 LIVE 배지 및 시청자 수 표시
 *  - 즐겨찾기 그룹 관리 및 생방송 중인 즐겨찾기 원클릭 일괄 추가
 *  - 치지직 로그인 상태 확인 및 원클릭 쿠키 동기화
 *  - 채팅 / 화면·소리 / 배치 / 동기화 / 통나무 / 알림 실시간 설정
 *  - JSON 백업 내보내기 / 가져오기 및 기본값 초기화
 */
(() => {
  const {
    parseChannelId,
    fetchChannelName,
    fetchLiveInfo,
    fetchFollowings,
    favorites,
    favGroups,
    channelGroups,
    settings,
    KEYS,
    read,
    write,
    exportData,
    importData,
    resetSettingsOnly,
  } = window.MyMV;
  const $ = (id) => document.getElementById(id);
  const VIEW_PAGE = chrome.runtime.getURL('multiview/multiview.html');

  const input = $('channelInput');
  const listEl = $('channelList');
  const errorEl = $('inputError');

  let channels = [];
  const names = new Map();
  const liveMap = new Map(); // id -> { status, viewers, title }
  let currentAuth = { loggedIn: false, nickname: '' };

  /* ---------------- 1. 치지직 로그인 상태 확인 및 연동 ---------------- */
  const authStatusEl = $('authStatus');
  const authLoginBtn = $('authLoginBtn');
  const authSyncBtn = $('authSyncBtn');

  function paintAuth(auth) {
    currentAuth = auth || { loggedIn: false, nickname: '' };
    if (currentAuth.loggedIn) {
      authStatusEl.textContent = `🟢 치지직 로그인 연동됨 (${currentAuth.nickname || '활성'})`;
      authLoginBtn.classList.add('hidden');
    } else {
      authStatusEl.textContent = '🔴 치지직 로그인이 필요합니다 (채팅 입력용)';
      authLoginBtn.classList.remove('hidden');
    }
  }

  function checkAuth() {
    chrome.runtime.sendMessage({ type: 'mv:check-auth' }, (resp) => {
      void chrome.runtime.lastError;
      if (resp && resp.auth) paintAuth(resp.auth);
    });
  }

  authLoginBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'mv:open-login' }, () => void chrome.runtime.lastError);
  });

  authSyncBtn.addEventListener('click', () => {
    authSyncBtn.textContent = '동기화 중…';
    authSyncBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'mv:sync-cookies' }, (resp) => {
      void chrome.runtime.lastError;
      authSyncBtn.disabled = false;
      authSyncBtn.textContent = '연동 완료!';
      if (resp && resp.auth) paintAuth(resp.auth);
      loadFollowings(true);
      setTimeout(() => {
        authSyncBtn.textContent = '쿠키 연동';
      }, 1500);
    });
  });

  checkAuth();

  /* ---------------- 2. 입력 읽기 및 채널 목록 ---------------- */
  function readLines() {
    const ids = [];
    const firstLine = new Map();
    const bad = [];
    for (const raw of input.value.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const id = parseChannelId(line);
      if (!id) {
        bad.push(line);
        continue;
      }
      if (!firstLine.has(id)) {
        firstLine.set(id, line);
        ids.push(id);
      }
    }
    return { ids, firstLine, bad };
  }

  function refresh() {
    const { ids, bad } = readLines();
    const keep = channels.filter((id) => ids.includes(id));
    for (const id of ids) if (!keep.includes(id)) keep.push(id);
    channels = keep;
    render(bad);
    if (typeof syncFollowAddedMarks === 'function') syncFollowAddedMarks();
  }

  function saveInput() {
    write(KEYS.input, input.value || '');
  }

  function rewriteInput() {
    const { firstLine, bad } = readLines();
    input.value = channels
      .map((id) => firstLine.get(id) || id)
      .concat(bad)
      .join('\n');
    saveInput();
  }

  function removeFromInput(id) {
    input.value = input.value
      .split(/\r?\n/)
      .filter((line) => line.trim() && parseChannelId(line.trim()) !== id)
      .map((line) => line.trim())
      .join('\n');
    saveInput();
    refresh();
  }

  function appendLine(text) {
    const cur = input.value.trim();
    input.value = cur ? cur + '\n' + text : text;
    saveInput();
  }

  /* ---------------- 채널 목록 (드래그 순서 변경 + LIVE 표시) ---------------- */
  let dragId = null;
  let dropAt = null;

  function clearDropMarks() {
    listEl
      .querySelectorAll('.drop-above, .drop-below')
      .forEach((el) => el.classList.remove('drop-above', 'drop-below'));
  }

  function findDropSpot(y) {
    for (const el of listEl.querySelectorAll('.ch')) {
      const id = el.dataset.id;
      if (!id || id === dragId) continue;
      const box = el.getBoundingClientRect();
      if (y < box.top + box.height / 2) return { id, after: false };
      if (y <= box.bottom) return { id, after: true };
    }
    return null;
  }

  function moveChannel(id, spot) {
    const from = channels.indexOf(id);
    if (from < 0) return;
    channels.splice(from, 1);
    if (!spot) channels.push(id);
    else {
      const to = channels.indexOf(spot.id);
      if (to < 0) channels.splice(from, 0, id);
      else channels.splice(spot.after ? to + 1 : to, 0, id);
    }
    rewriteInput();
    render(readLines().bad);
  }

  listEl.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dropAt = findDropSpot(e.clientY);
    clearDropMarks();
    if (dropAt) {
      const el = listEl.querySelector(`.ch[data-id="${dropAt.id}"]`);
      if (el) el.classList.add(dropAt.after ? 'drop-below' : 'drop-above');
    }
  });
  listEl.addEventListener('dragleave', (e) => {
    if (e.relatedTarget instanceof Node && listEl.contains(e.relatedTarget)) return;
    dropAt = null;
    clearDropMarks();
  });
  listEl.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const id = dragId;
    const spot = dropAt;
    dragId = null;
    dropAt = null;
    clearDropMarks();
    moveChannel(id, spot);
  });

  function labelFor(id) {
    return names.get(id) || id;
  }

  function render(bad) {
    const countEl = $('channelCount');
    if (countEl) countEl.textContent = `인식된 채널: ${channels.length}`;
    if (listEl) {
      listEl.textContent = '';
      for (const id of channels) listEl.appendChild(makeItem(id));
    }
    if (errorEl) {
      if (bad && bad.length) {
        const shown = bad.slice(0, 3).join(' / ');
        errorEl.textContent =
          bad.length > 3 ? `인식 불가: ${shown} 외 ${bad.length - 3}개` : `인식 불가: ${shown}`;
      } else {
        errorEl.textContent = '';
      }
    }
  }

  function makeItem(id) {
    const el = document.createElement('div');
    el.className = 'ch';
    el.draggable = true;
    el.dataset.id = id;
    el.setAttribute('aria-label', '드래그로 순서 변경');

    const liveDot = document.createElement('span');
    liveDot.className = 'live-dot hidden';
    liveDot.textContent = 'LIVE';

    const name = document.createElement('span');
    name.className = 'ch-name';
    const paintMeta = () => {
      const n = labelFor(id);
      const lv = liveMap.get(id);
      name.textContent = n;
      if (lv && lv.status === 'OPEN') {
        el.classList.add('is-live');
        liveDot.classList.remove('hidden');
        const vStr = lv.viewers ? ` · ${lv.viewers.toLocaleString()}명 시청 중` : '';
        const tStr = lv.title ? `\n방제: ${lv.title}` : '';
        el.title = `${n} (생방송 중${vStr})${tStr}`;
      } else {
        el.classList.remove('is-live');
        liveDot.classList.add('hidden');
        el.title = names.has(id) ? `${names.get(id)} (${id})` : id;
      }
    };
    paintMeta();

    const heart = document.createElement('button');
    heart.type = 'button';
    heart.className = 'ch-heart';
    heart.draggable = false;
    const paintHeart = () => {
      const on = favorites.has(id);
      heart.textContent = on ? '♥' : '♡';
      heart.classList.toggle('on', on);
      heart.title = on ? '즐겨찾기 삭제' : '즐겨찾기 추가';
    };
    paintHeart();
    heart.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (favorites.has(id)) favorites.remove(id);
      else favorites.add(id, names.get(id) || '', channelGroups ? channelGroups.get(id) : '');
      paintHeart();
      renderFavorites();
      if (typeof renderFollowings === 'function') renderFollowings();
    });

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'ch-x';
    x.draggable = false;
    x.title = '이 채널 제거';
    x.textContent = '×';
    x.addEventListener('click', () => removeFromInput(id));

    const tools = document.createElement('div');
    tools.className = 'ch-tools';
    tools.append(liveDot, heart, x);
    el.append(name, tools);

    el.addEventListener('dragstart', (e) => {
      dragId = id;
      dropAt = null;
      el.classList.add('is-moving');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', id);
      }
    });
    el.addEventListener('dragend', () => {
      dragId = null;
      dropAt = null;
      el.classList.remove('is-moving');
      clearDropMarks();
    });

    // 채널명 및 생방송 여부 비동기 조회
    fetchLiveInfo(id).then((info) => {
      if (info.name) names.set(id, info.name);
      if (info.status) liveMap.set(id, info);
      if (el.isConnected) paintMeta();
    });
    if (!names.has(id)) {
      fetchChannelName(id).then((n) => {
        if (!n) return;
        names.set(id, n);
        if (el.isConnected) paintMeta();
      });
    }
    return el;
  }

  /* ---------------- 3-0. 팔로우 채널 (내 치지직 계정 팔로잉 목록 자동 조회 + 그룹 묶기) ---------------- */
  let followings = [];
  let followLoaded = false;
  let followLoading = false;
  let followMode = 'all'; // 'all' | 'live' | 'group'
  let followGroupFilterVal = '';
  let followSearchQuery = '';
  let favDragId = null;

  function syncFollowGroupOptions() {
    const sel = $('followGroupFilter');
    if (!sel) return;
    const prev = sel.value;
    const gList = favGroups.list();
    sel.textContent = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = '전체 그룹';
    sel.appendChild(optAll);
    for (const g of gList) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = `📁 ${g}`;
      sel.appendChild(opt);
    }
    const optNone = document.createElement('option');
    optNone.value = '__none__';
    optNone.textContent = '그룹 미지정';
    sel.appendChild(optNone);
    if (prev && (prev === '__none__' || gList.includes(prev))) {
      sel.value = prev;
      followGroupFilterVal = prev;
    } else {
      sel.value = '';
      followGroupFilterVal = '';
    }
  }

  function syncFollowAddedMarks() {
    const box = $('followList');
    if (!box) return;
    box.querySelectorAll('.follow-card').forEach((card) => {
      const cid = card.dataset.id;
      card.classList.toggle('is-added', !!(cid && channels.includes(cid)));
    });
  }

  function makeFollowCard(item, notice) {
    const card = document.createElement('div');
    card.className = 'follow-card' + (item.status === 'OPEN' ? ' is-live' : '') + (channels.includes(item.id) ? ' is-added' : '');
    card.dataset.id = item.id;
    card.draggable = true;
    card.addEventListener('dragstart', (e) => {
      favDragId = item.id;
      card.classList.add('is-moving');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);
      }
    });
    card.addEventListener('dragend', () => {
      favDragId = null;
      card.classList.remove('is-moving');
    });

    const avatar = document.createElement('div');
    avatar.className = 'follow-avatar';
    if (item.imageUrl) {
      const img = document.createElement('img');
      img.src = item.imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        img.remove();
        avatar.textContent = (item.name || item.id).slice(0, 1);
      });
      avatar.appendChild(img);
    } else {
      avatar.textContent = (item.name || item.id).slice(0, 1);
    }

    const info = document.createElement('div');
    info.className = 'follow-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'follow-name-row';

    if (item.status === 'OPEN') {
      const dot = document.createElement('span');
      dot.className = 'live-dot';
      dot.textContent = 'LIVE';
      nameRow.appendChild(dot);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'follow-name';
    nameEl.textContent = item.name || item.id.slice(0, 8);
    nameRow.appendChild(nameEl);

    if (item.status === 'OPEN' && item.viewers > 0) {
      const vEl = document.createElement('span');
      vEl.className = 'follow-viewers';
      vEl.textContent = `${item.viewers.toLocaleString()}명`;
      nameRow.appendChild(vEl);
    }

    const sub = document.createElement('div');
    sub.className = 'follow-sub';
    if (item.status === 'OPEN') {
      sub.textContent = item.title || item.category || '생방송 중';
    } else {
      sub.textContent = '오프라인';
    }

    info.append(nameRow, sub);

    const actions = document.createElement('div');
    actions.className = 'follow-actions';

    // 그룹 선택 드롭다운 (팔로우 채널을 그룹으로 바로 묶어둘 수 있음)
    const grpSel = document.createElement('select');
    const curGrp = channelGroups.get(item.id);
    grpSel.className = 'follow-grp-sel' + (curGrp ? ' has-grp' : '');
    grpSel.title = '이 팔로워를 묶어둘 그룹 선택';
    const optEmpty = document.createElement('option');
    optEmpty.value = '';
    optEmpty.textContent = '그룹 없음';
    grpSel.appendChild(optEmpty);
    for (const g of favGroups.list()) {
      const o = document.createElement('option');
      o.value = g;
      o.textContent = g;
      grpSel.appendChild(o);
    }
    const optNew = document.createElement('option');
    optNew.value = '__new__';
    optNew.textContent = '+ 새 그룹…';
    grpSel.appendChild(optNew);
    grpSel.value = curGrp || '';

    grpSel.addEventListener('click', (e) => e.stopPropagation());
    grpSel.addEventListener('change', (e) => {
      e.stopPropagation();
      let val = grpSel.value;
      if (val === '__new__') {
        const inp = $('followGrpAddInput');
        if (inp) {
          inp.focus();
          if (notice) {
            notice.classList.add('ok');
            notice.textContent = '위 입력칸에서 새 그룹 이름을 만들고 지정해 보세요.';
          }
        }
        grpSel.value = curGrp || '';
        return;
      }
      channelGroups.set(item.id, val, item.name);
      renderFollowings();
      renderFavorites();
    });

    // 즐겨찾기 하트 토글
    const heart = document.createElement('button');
    heart.type = 'button';
    heart.className = 'ch-heart';
    const paintHeart = () => {
      const on = favorites.has(item.id);
      heart.textContent = on ? '♥' : '♡';
      heart.classList.toggle('on', on);
      heart.title = on ? '즐겨찾기 해제' : '즐겨찾기에 추가';
    };
    paintHeart();
    heart.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (favorites.has(item.id)) {
        favorites.remove(item.id);
      } else {
        favorites.add(item.id, item.name || '', channelGroups.get(item.id));
      }
      paintHeart();
      renderFavorites();
    });

    actions.append(grpSel, heart);
    card.append(avatar, info, actions);

    const vStr = item.status === 'OPEN' && item.viewers ? ` · ${item.viewers.toLocaleString()}명 시청 중` : '';
    const tStr = item.title ? `\n방제: ${item.title}` : '';
    card.title = `${item.name || item.id} (${item.status === 'OPEN' ? '생방송 중' + vStr : '오프라인'})${tStr}\n클릭하면 방송 추가 목록에 들어갑니다.`;

    card.addEventListener('click', () => {
      if (channels.includes(item.id)) {
        if (notice) {
          notice.classList.remove('ok');
          notice.textContent = `이미 추가 목록에 있어요: ${item.name || item.id}`;
        }
        return;
      }
      if (notice) {
        notice.classList.add('ok');
        notice.textContent = `추가됨: ${item.name || item.id}`;
      }
      addToInput([item.id]);
    });

    return card;
  }

  function filteredFollowings() {
    const q = followSearchQuery.trim().toLowerCase();
    return followings.filter((item) => {
      if (followMode === 'live' && item.status !== 'OPEN') return false;
      const g = channelGroups.get(item.id);
      if (followGroupFilterVal === '__none__' && g) return false;
      if (followGroupFilterVal && followGroupFilterVal !== '__none__' && g !== followGroupFilterVal) return false;
      if (q) {
        const hay = `${item.name} ${item.title} ${item.category} ${g} ${item.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderFollowings() {
    syncFollowGroupOptions();
    const box = $('followList');
    const empty = $('followEmpty');
    const badge = $('followCountBadge');
    const notice = $('followNotice');
    if (!box) return;
    box.textContent = '';

    const liveTotal = followings.filter((x) => x.status === 'OPEN').length;
    if (badge) {
      if (followLoading && !followings.length) {
        badge.textContent = '불러오는 중…';
      } else {
        badge.textContent = `생방송 ${liveTotal} / 전체 ${followings.length}`;
      }
    }

    if (followLoading && !followings.length) {
      if (empty) {
        empty.style.display = 'block';
        empty.textContent = '내 치지직 팔로우 채널 목록을 불러오는 중입니다…';
      }
      return;
    }

    if (!followings.length) {
      if (empty) {
        empty.style.display = 'block';
        empty.textContent = currentAuth.loggedIn
          ? '팔로우 중인 채널이 없거나 목록을 불러오지 못했어요. [↻ 새로고침] 또는 상단 [쿠키 연동]을 눌러보세요.'
          : '치지직 로그인 후 [쿠키 연동]을 누르면 내 팔로우 채널 목록이 자동으로 표시됩니다.';
      }
      return;
    }

    const list = filteredFollowings();
    if (!list.length) {
      if (empty) {
        empty.style.display = 'block';
        empty.textContent =
          followMode === 'live'
            ? '현재 생방송 중인 팔로우 채널이 없어요.'
            : '조건에 맞는 팔로우 채널이 없어요.';
      }
      return;
    }
    if (empty) empty.style.display = 'none';

    if (followMode === 'group') {
      const gNames = favGroups.list();
      const blocks = [];
      for (const g of gNames) {
        if (followGroupFilterVal && followGroupFilterVal !== g) continue;
        blocks.push({
          group: g,
          items: list.filter((x) => channelGroups.get(x.id) === g),
        });
      }
      if (!followGroupFilterVal || followGroupFilterVal === '__none__') {
        blocks.push({
          group: '',
          items: list.filter((x) => !channelGroups.get(x.id)),
        });
      }

      blocks.forEach((blk, bi) => {
        const named = blk.group !== '';
        const wrap = document.createElement('div');
        wrap.className = 'grp' + (named ? '' : ' grp-none');

        const head = document.createElement('div');
        head.className = 'grp-head';
        const name = document.createElement('span');
        name.className = 'grp-name';
        name.textContent = named ? `📁 ${blk.group}` : '그룹 미지정 팔로워';
        const liveInBlk = blk.items.filter((x) => x.status === 'OPEN').length;
        const count = document.createElement('span');
        count.className = 'grp-count';
        count.textContent = liveInBlk ? `🔴 ${liveInBlk} / ${blk.items.length}` : String(blk.items.length);
        head.append(name, count);

        const tools = document.createElement('span');
        tools.className = 'grp-tools';
        if (liveInBlk > 0) {
          tools.appendChild(
            smallBtn('🔴 생방송 추가', '이 그룹에서 생방송 중인 채널만 추가', () => {
              const n = addToInput(blk.items.filter((x) => x.status === 'OPEN').map((x) => x.id));
              if (notice) {
                notice.classList.toggle('ok', n > 0);
                notice.textContent = n ? `생방송 ${n}개 채널 추가됨` : '이미 모두 추가됨';
              }
            }),
          );
        }
        if (blk.items.length > 0) {
          tools.appendChild(
            smallBtn('전체 추가', '이 그룹 전체 추가', () => {
              const n = addToInput(blk.items.map((x) => x.id));
              if (notice) {
                notice.classList.toggle('ok', n > 0);
                notice.textContent = n ? `${n}개 채널 추가됨` : '이미 모두 추가됨';
              }
            }),
          );
        }
        if (named) {
          if (bi > 0) {
            tools.appendChild(
              smallBtn('▲', '위로', () => {
                favGroups.move(blk.group, -1);
                renderFollowings();
                renderFavorites();
              }),
            );
          }
          if (bi < gNames.length - 1) {
            tools.appendChild(
              smallBtn('▼', '아래로', () => {
                favGroups.move(blk.group, 1);
                renderFollowings();
                renderFavorites();
              }),
            );
          }
          tools.appendChild(
            smallBtn('삭제', '그룹 삭제', () => {
              favGroups.remove(blk.group);
              renderFollowings();
              renderFavorites();
            }),
          );
        }
        head.appendChild(tools);
        wrap.appendChild(head);

        if (blk.items.length) {
          const grid = document.createElement('div');
          grid.className = 'follow-grid';
          for (const item of blk.items) grid.appendChild(makeFollowCard(item, notice));
          wrap.appendChild(grid);
        } else {
          const hint = document.createElement('div');
          hint.className = 'grp-empty';
          hint.textContent = '팔로우 채널 카드를 여기로 끌어다 놓거나 카드 우측에서 그룹을 선택하세요';
          wrap.appendChild(hint);
        }

        wrap.addEventListener('dragover', (e) => {
          if (!favDragId) return;
          e.preventDefault();
          wrap.classList.add('drop');
        });
        wrap.addEventListener('dragleave', (e) => {
          if (!(e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget))) wrap.classList.remove('drop');
        });
        wrap.addEventListener('drop', (e) => {
          if (!favDragId) return;
          e.preventDefault();
          const fItem = followings.find((x) => x.id === favDragId);
          channelGroups.set(favDragId, blk.group, fItem ? fItem.name : '');
          favDragId = null;
          renderFollowings();
          renderFavorites();
        });

        box.appendChild(wrap);
      });
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'follow-grid';
    for (const item of list) {
      grid.appendChild(makeFollowCard(item, notice));
    }
    box.appendChild(grid);
  }

  async function loadFollowings(forceRefresh = false) {
    if (followLoading) return;
    followLoading = true;
    const refreshBtn = $('refreshFollowBtn');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = '조회 중…';
    }
    renderFollowings();
    try {
      const res = await fetchFollowings(forceRefresh);
      followLoaded = true;
      followings = Array.isArray(res && res.list) ? res.list : [];
      for (const item of followings) {
        if (item.name) names.set(item.id, item.name);
        liveMap.set(item.id, { status: item.status, viewers: item.viewers, title: item.title, name: item.name });
      }
    } catch {} finally {
      followLoading = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = '↻ 새로고침';
      }
      renderFollowings();
      render(readLines().bad);
    }
  }

  document.querySelectorAll('.follow-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      followMode = btn.dataset.mode || 'all';
      document.querySelectorAll('.follow-tab').forEach((b) => b.classList.toggle('on', b === btn));
      renderFollowings();
    });
  });

  if ($('followGroupFilter')) {
    $('followGroupFilter').addEventListener('change', (e) => {
      followGroupFilterVal = e.target.value || '';
      renderFollowings();
    });
  }

  if ($('followSearchInput')) {
    $('followSearchInput').addEventListener('input', (e) => {
      followSearchQuery = e.target.value || '';
      renderFollowings();
    });
  }

  if ($('refreshFollowBtn')) {
    $('refreshFollowBtn').addEventListener('click', () => {
      const notice = $('followNotice');
      if (notice) notice.textContent = '';
      loadFollowings(true);
    });
  }

  if ($('addLiveFollowsBtn')) {
    $('addLiveFollowsBtn').addEventListener('click', async () => {
      const notice = $('followNotice');
      if (!followLoaded) await loadFollowings(true);
      const targetList = filteredFollowings().filter((x) => x.status === 'OPEN');
      if (!targetList.length) {
        if (notice) {
          notice.classList.remove('ok');
          notice.textContent = '현재 조건에서 생방송 중인 팔로우 채널이 없어요.';
        }
        return;
      }
      const added = addToInput(targetList.map((x) => x.id));
      if (notice) {
        notice.classList.add('ok');
        notice.textContent = added
          ? `생방송 중인 팔로우 채널 ${added}개를 목록에 추가했어요!`
          : `생방송 중인 팔로우 채널(${targetList.length}개)이 이미 모두 목록에 있어요.`;
      }
    });
  }

  if ($('followGrpAddForm')) {
    $('followGrpAddForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = $('followGrpAddInput');
      const notice = $('followNotice');
      const val = inp ? inp.value.trim() : '';
      if (!val) return;
      if (!favGroups.add(val)) {
        if (notice) {
          notice.classList.remove('ok');
          notice.textContent = '같은 이름의 그룹이 이미 있어요.';
        }
        return;
      }
      inp.value = '';
      if (notice) {
        notice.classList.add('ok');
        notice.textContent = `'${val}' 그룹이 생성되었습니다. 각 채널 우측에서 그룹을 선택하거나 그룹별 보기에서 끌어다 놓으세요.`;
      }
      renderFollowings();
      renderFavorites();
    });
  }

  /* ---------------- 3. 즐겨찾기 (그룹 + 생방송 표시 + 생방송 일괄 추가) ---------------- */

  function addToInput(ids) {
    let added = 0;
    for (const id of ids) {
      if (channels.includes(id)) continue;
      appendLine(id);
      channels.push(id);
      added += 1;
    }
    refresh();
    return added;
  }

  function makeFav(f, notice) {
    const item = document.createElement('div');
    item.className = 'fav';
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      favDragId = f.id;
      item.classList.add('is-moving');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', f.id);
    });
    item.addEventListener('dragend', () => {
      favDragId = null;
      item.classList.remove('is-moving');
    });

    const liveDot = document.createElement('span');
    liveDot.className = 'live-dot hidden';
    liveDot.textContent = 'LIVE';

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'fav-name';
    add.draggable = false;
    add.textContent = favorites.label(f);
    add.title = f.name ? `${f.name} (${f.id})` : f.id;
    add.addEventListener('click', () => {
      if (channels.includes(f.id)) {
        if (notice) {
          notice.classList.remove('ok');
          notice.textContent = `이미 추가됨: ${f.name || f.id}`;
        }
        return;
      }
      if (notice) notice.textContent = '';
      addToInput([f.id]);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fav-del';
    del.draggable = false;
    del.title = '즐겨찾기 삭제';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      favorites.remove(f.id);
      renderFavorites();
      render(readLines().bad);
    });

    item.append(liveDot, add, del);

    // 생방송 여부 및 이름 자동 보강
    fetchLiveInfo(f.id).then((info) => {
      if (info.name && !f.name) {
        favorites.updateName(f.id, info.name);
        add.textContent = info.name;
      }
      if (info.status) liveMap.set(f.id, info);
      if (info.status === 'OPEN' && item.isConnected) {
        item.classList.add('is-live');
        liveDot.classList.remove('hidden');
        const vStr = info.viewers ? ` · ${info.viewers.toLocaleString()}명 시청 중` : '';
        const tStr = info.title ? `\n방제: ${info.title}` : '';
        add.title = `${info.name || f.name || f.id} (생방송 중${vStr})${tStr}`;
      }
    });

    return item;
  }

  function smallBtn(text, title, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'grp-btn';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  function startRename(nameEl, group) {
    const inp = document.createElement('input');
    inp.className = 'grp-rename';
    inp.value = group;
    nameEl.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok && inp.value.trim() && inp.value.trim() !== group && !favGroups.rename(group, inp.value)) {
        $('favNotice').textContent = '같은 이름의 그룹이 이미 있어요.';
      }
      renderFavorites();
      if (typeof renderFollowings === 'function') renderFollowings();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
  }

  function renderFavorites() {
    const box = $('favList');
    const notice = $('favNotice');
    if (box) box.textContent = '';
    if (notice) notice.textContent = '';
    const all = favorites.list();
    const blocks = favorites.grouped();
    const groupCount = blocks.length - 1;
    const favEmpty = $('favEmpty');
    if (favEmpty) favEmpty.style.display = all.length || groupCount ? 'none' : 'block';
    if (!box) return;

    blocks.forEach((blk, bi) => {
      const named = blk.group !== '';
      if (!named && !blk.items.length && groupCount) return;
      if (!named && !all.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'grp' + (named ? '' : ' grp-none');

      if (named || groupCount) {
        const head = document.createElement('div');
        head.className = 'grp-head';
        const name = document.createElement('span');
        name.className = 'grp-name';
        name.textContent = named ? blk.group : '그룹 없음';
        const count = document.createElement('span');
        count.className = 'grp-count';
        count.textContent = String(blk.items.length);
        head.append(name, count);
        const tools = document.createElement('span');
        tools.className = 'grp-tools';
        if (blk.items.length) {
          tools.appendChild(
            smallBtn('전체 추가', '그룹 전체 추가', () => {
              const n = addToInput(blk.items.map((f) => f.id));
              if (notice) {
                notice.classList.toggle('ok', n > 0);
                notice.textContent = n ? `${n}개 채널 추가됨` : '이미 모두 추가됨';
              }
            }),
          );
        }
        if (named) {
          if (bi > 1)
            tools.appendChild(
              smallBtn('▲', '위로', () => {
                favGroups.move(blk.group, -1);
                renderFavorites();
              }),
            );
          if (bi < blocks.length - 1)
            tools.appendChild(
              smallBtn('▼', '아래로', () => {
                favGroups.move(blk.group, 1);
                renderFavorites();
              }),
            );
          tools.appendChild(smallBtn('이름', '이름 변경', () => startRename(name, blk.group)));
          tools.appendChild(
            smallBtn('삭제', '그룹 삭제', () => {
              favGroups.remove(blk.group);
              renderFavorites();
              if (typeof renderFollowings === 'function') renderFollowings();
            }),
          );
        }
        head.appendChild(tools);
        wrap.appendChild(head);
      }

      const items = document.createElement('div');
      items.className = 'fav-items';
      for (const f of blk.items) items.appendChild(makeFav(f, notice));
      if (!blk.items.length) {
        const hint = document.createElement('div');
        hint.className = 'grp-empty';
        hint.textContent = '즐겨찾기를 여기로 끌어다 놓기';
        items.appendChild(hint);
      }
      wrap.appendChild(items);

      wrap.addEventListener('dragover', (e) => {
        if (!favDragId) return;
        e.preventDefault();
        wrap.classList.add('drop');
      });
      wrap.addEventListener('dragleave', (e) => {
        if (!(e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget))) wrap.classList.remove('drop');
      });
      wrap.addEventListener('drop', (e) => {
        if (!favDragId) return;
        e.preventDefault();
        favorites.setGroup(favDragId, blk.group);
        favDragId = null;
        renderFavorites();
        if (typeof renderFollowings === 'function') renderFollowings();
      });
      box.appendChild(wrap);
    });
  }

  $('grpAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('grpAddInput');
    const notice = $('favNotice');
    if (!favGroups.add(inp.value)) {
      if (notice) {
        notice.classList.remove('ok');
        notice.textContent = inp.value.trim() ? '같은 이름의 그룹이 이미 있어요.' : '';
      }
      return;
    }
    inp.value = '';
    renderFavorites();
    if (typeof renderFollowings === 'function') renderFollowings();
  });

  // 생방송 중인 즐겨찾기 모두 추가 버튼
  $('addLiveFavsBtn').addEventListener('click', async () => {
    const notice = $('favNotice');
    const all = favorites.list();
    if (!all.length) {
      if (notice) {
        notice.classList.remove('ok');
        notice.textContent = '등록된 즐겨찾기가 없어요.';
      }
      return;
    }
    const btn = $('addLiveFavsBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '생방송 확인 중…';
    }
    const liveIds = [];
    await Promise.all(
      all.map(async (f) => {
        const info = await fetchLiveInfo(f.id, 5000);
        if (info && info.status === 'OPEN') liveIds.push(f.id);
      }),
    );
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔴 생방송 채널 모두 추가';
    }
    if (!liveIds.length) {
      if (notice) {
        notice.classList.remove('ok');
        notice.textContent = '현재 생방송 중인 즐겨찾기 채널이 없어요.';
      }
      return;
    }
    const added = addToInput(liveIds);
    if (notice) {
      notice.classList.add('ok');
      notice.textContent = added
        ? `생방송 중인 채널 ${added}개를 목록에 추가했어요!`
        : `생방송 채널(${liveIds.length}개)이 이미 모두 목록에 있어요.`;
    }
  });

  /* ---------------- 4. 왼쪽 메뉴 네비게이션 ---------------- */
  const page = $('page');
  const navItems = [...document.querySelectorAll('.side-item')];
  const sections = navItems.map((a) => document.querySelector(a.getAttribute('href')));
  navItems.forEach((a, i) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (sections[i]) page.scrollTo({ top: sections[i].offsetTop - page.offsetTop - 8 });
    }),
  );
  function markNav() {
    const y = page.scrollTop + 40;
    let cur = 0;
    sections.forEach((s, i) => {
      if (s && s.offsetTop - page.offsetTop <= y) cur = i;
    });
    if (page.scrollTop + page.clientHeight >= page.scrollHeight - 2) cur = sections.length - 1;
    navItems.forEach((a, i) => a.classList.toggle('on', i === cur));
  }
  page.addEventListener('scroll', markNav, { passive: true });
  markNav();
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  /* ---------------- 5. 설정 바인딩 ---------------- */
  const posLeft = $('chatPosLeft');
  const posRight = $('chatPosRight');
  const onPos = () => {
    settings.chatPosition = posLeft.checked ? 'left' : 'right';
  };
  posLeft.addEventListener('change', onPos);
  posRight.addEventListener('change', onPos);

  const fitContain = $('videoFitContain');
  const fitCover = $('videoFitCover');
  const onFit = () => {
    settings.videoFit = fitCover.checked ? 'cover' : 'contain';
  };
  fitContain.addEventListener('change', onFit);
  fitCover.addEventListener('change', onFit);

  const bindBox = (id, key) => {
    const box = $(id);
    if (!box) return null;
    box.checked = settings[key];
    box.addEventListener('change', () => {
      settings[key] = box.checked;
    });
    return box;
  };

  bindBox('chatTimeBox', 'chatTime');
  bindBox('chatPreloadBox', 'chatPreload');
  bindBox('autoLpBox', 'autoLp');
  bindBox('chatHideCheeseBox', 'chatHideCheese');
  bindBox('chatHideSubBox', 'chatHideSub');
  bindBox('chatHideBlindBox', 'chatHideBlind');
  bindBox('chatHideRankBox', 'chatHideRank');
  bindBox('chatHideMissionBox', 'chatHideMission');
  bindBox('chatHidePredictBox', 'chatHidePredict');
  bindBox('chatHideDonationBox', 'chatHideDonation');
  bindBox('chatHideBadgeBox', 'chatHideBadge');
  bindBox('chatRestoreBlindBox', 'chatRestoreBlind');
  bindBox('hoverAudioBox', 'hoverAudio');
  bindBox('tileAudioCompressBox', 'tileAudioCompress');
  bindBox('tileAdMuteBox', 'tileAdMute');
  bindBox('alwaysShowBarBox', 'alwaysShowBar');
  bindBox('notifyLiveBox', 'notifyLive');

  const defaultQualitySelect = $('defaultQualitySelect');
  if (defaultQualitySelect) {
    defaultQualitySelect.value = settings.defaultQuality;
    defaultQualitySelect.addEventListener('change', () => {
      settings.defaultQuality = defaultQualitySelect.value;
    });
  }

  const gridColsSelect = $('gridColsSelect');
  if (gridColsSelect) {
    gridColsSelect.value = String(settings.gridCols);
    gridColsSelect.addEventListener('change', () => {
      settings.gridCols = gridColsSelect.value;
    });
  }

  const fontInput = $('chatFontSize');
  fontInput.value = String(settings.chatFontSize);
  fontInput.addEventListener('change', () => {
    settings.chatFontSize = fontInput.value;
    fontInput.value = String(settings.chatFontSize);
  });

  const colorDefault = $('chatColorDefault');
  const colorCustom = $('chatColorCustom');
  const colorRow = $('chatColorRow');
  const syncColorRow = () => {
    if (!colorRow || !colorCustom) return;
    colorRow.style.display = colorCustom.checked ? '' : 'none';
  };
  const onColorMode = () => {
    settings.chatColorMode = colorCustom.checked ? 'custom' : 'default';
    syncColorRow();
  };
  if (colorDefault) colorDefault.addEventListener('change', onColorMode);
  if (colorCustom) colorCustom.addEventListener('change', onColorMode);

  const nickColor = $('chatNickColor');
  const bodyColor = $('chatBodyColor');
  nickColor.addEventListener('change', () => {
    settings.chatNickColor = nickColor.value;
  });
  bodyColor.addEventListener('change', () => {
    settings.chatBodyColor = bodyColor.value;
  });

  const pinInput = $('chatPinInput');
  pinInput.addEventListener('change', () => {
    const list = pinInput.value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    window.MyMV.pinUsers.save([...new Set(list)]);
  });

  const bindPct = (id, key) => {
    const el = $(id);
    if (!el) return;
    el.value = String(settings[key]);
    el.addEventListener('change', () => {
      settings[key] = el.value;
      el.value = String(settings[key]);
    });
  };
  bindPct('tileBrightness', 'tileBrightness');
  bindPct('tileContrast', 'tileContrast');
  bindPct('tileSaturate', 'tileSaturate');
  bindPct('tileGamma', 'tileGamma');

  $('resetFilterBtn').addEventListener('click', () => {
    settings.tileBrightness = 100;
    settings.tileContrast = 100;
    settings.tileSaturate = 100;
    settings.tileGamma = 100;
    syncSettingsUI();
  });

  const ffBox = bindBox('autoFfBox', 'autoFf');
  const ffSec = $('autoFfSec');
  const presets = [...document.querySelectorAll('.sec-preset')];
  const setSec = (v) => {
    settings.autoFfSec = v;
    ffSec.value = String(settings.autoFfSec);
  };
  ffSec.addEventListener('change', () => setSec(ffSec.value));
  presets.forEach((b) => b.addEventListener('click', () => setSec(b.dataset.sec)));
  const paintFf = () => {
    ffSec.disabled = !ffBox.checked;
    presets.forEach((b) => {
      b.disabled = !ffBox.checked;
    });
  };
  ffBox.addEventListener('change', paintFf);

  function syncSettingsUI() {
    (settings.chatPosition === 'left' ? posLeft : posRight).checked = true;
    (settings.videoFit === 'cover' ? fitCover : fitContain).checked = true;
    if (defaultQualitySelect) defaultQualitySelect.value = settings.defaultQuality;
    if (gridColsSelect) gridColsSelect.value = String(settings.gridCols);
    $('chatTimeBox').checked = settings.chatTime;
    $('chatPreloadBox').checked = settings.chatPreload;
    $('autoLpBox').checked = settings.autoLp;
    $('chatHideCheeseBox').checked = settings.chatHideCheese;
    $('chatHideSubBox').checked = settings.chatHideSub;
    $('chatHideBlindBox').checked = settings.chatHideBlind;
    $('chatHideRankBox').checked = settings.chatHideRank;
    $('chatHideMissionBox').checked = settings.chatHideMission;
    $('chatHidePredictBox').checked = settings.chatHidePredict;
    $('chatHideDonationBox').checked = settings.chatHideDonation;
    $('chatHideBadgeBox').checked = settings.chatHideBadge;
    $('chatRestoreBlindBox').checked = settings.chatRestoreBlind;
    $('hoverAudioBox').checked = settings.hoverAudio;
    $('tileAudioCompressBox').checked = settings.tileAudioCompress;
    $('tileAdMuteBox').checked = settings.tileAdMute;
    $('alwaysShowBarBox').checked = settings.alwaysShowBar;
    $('notifyLiveBox').checked = settings.notifyLive;
    fontInput.value = String(settings.chatFontSize);
    (settings.chatColorMode === 'custom' ? colorCustom : colorDefault).checked = true;
    syncColorRow();
    nickColor.value = settings.chatNickColor;
    bodyColor.value = settings.chatBodyColor;
    pinInput.value = window.MyMV.pinUsers.list().join(', ');
    $('tileBrightness').value = String(settings.tileBrightness);
    $('tileContrast').value = String(settings.tileContrast);
    $('tileSaturate').value = String(settings.tileSaturate);
    $('tileGamma').value = String(settings.tileGamma);
    ffBox.checked = settings.autoFf;
    ffSec.value = String(settings.autoFfSec);
    paintFf();
  }
  syncSettingsUI();

  /* ---------------- 6. 백업 / 복원 / 초기화 ---------------- */
  const backupNotice = $('backupNotice');
  $('exportBtn').addEventListener('click', () => {
    try {
      const json = exportData();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `my-multiview-backup-${dateStr}.json`;
      a.click();
      URL.revokeObjectURL(url);
      backupNotice.classList.add('ok');
      backupNotice.textContent = '백업 파일이 다운로드되었습니다.';
    } catch (err) {
      backupNotice.classList.remove('ok');
      backupNotice.textContent = '내보내기 실패: ' + err.message;
    }
  });

  const importFileInput = $('importFileInput');
  $('importBtn').addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', async () => {
    const file = importFileInput.files && importFileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const count = importData(text);
      input.value = read(KEYS.input) || '';
      refresh();
      renderFavorites();
      syncSettingsUI();
      backupNotice.classList.add('ok');
      backupNotice.textContent = `백업 복원 완료 (${count}개 항목 적용됨)`;
    } catch (err) {
      backupNotice.classList.remove('ok');
      backupNotice.textContent = '가져오기 실패: 올바른 백업 JSON 파일인지 확인하세요.';
    } finally {
      importFileInput.value = '';
    }
  });

  $('resetSettingsBtn').addEventListener('click', () => {
    resetSettingsOnly();
    syncSettingsUI();
    backupNotice.classList.add('ok');
    backupNotice.textContent = '설정이 기본값으로 초기화되었습니다 (즐겨찾기·그룹은 유지됨).';
  });

  /* ---------------- 7. 상단 액션 버튼 ---------------- */
  input.addEventListener('input', () => {
    saveInput();
    refresh();
  });
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('addListBtn').click();
  });

  $('clearBtn').addEventListener('click', () => {
    input.value = '';
    saveInput();
    refresh();
    input.focus();
  });

  async function findViewTab() {
    const tabs = await chrome.tabs.query({ url: VIEW_PAGE + '*' });
    return tabs.find((t) => t.id != null && (t.url || '').startsWith(VIEW_PAGE)) || null;
  }
  function focusTab(tab) {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
  }

  // 멀티뷰 열기: 마지막에 보던 방송들 그대로 (이미 열려 있으면 그 탭으로)
  $('openBtn').addEventListener('click', async () => {
    const open = await findViewTab();
    if (open) { focusTab(open); return; }
    chrome.tabs.create({ url: VIEW_PAGE });
  });

  // 방송 목록 추가: 아래 '방송 추가' 칸에 적은 채널들을 멀티뷰에 더함 (마지막에 보던 방송은 그대로)
  $('addListBtn').addEventListener('click', async () => {
    refresh();
    const ids = [...channels];
    if (!ids.length) {
      errorEl.textContent = '아래 방송 추가 칸에 채널 ID나 주소를 먼저 넣어주세요.';
      input.focus();
      return;
    }
    const open = await findViewTab();
    if (open) {
      chrome.tabs.sendMessage(open.id, { type: 'mv:add', ids }, () => void chrome.runtime.lastError);
      focusTab(open);
      return;
    }
    const q = new URLSearchParams();
    for (const id of ids) q.append('add', id);
    chrome.tabs.create({ url: `${VIEW_PAGE}?${q}` });
  });

  /* ---------------- 시작 ---------------- */
  input.value = read(KEYS.input) || '';
  refresh();
  renderFavorites();
  loadFollowings(false);

  /* ---------------- 8. 버그 제보 / 후원 모달 ---------------- */
  const BUG_CONTACT = '';
  const DONATE_TEXT = '후원 창구는 준비 중이에요. 사용해 주셔서 고마워요!';

  const bugModal = $('bugModal');
  const donateModal = $('donateModal');
  const bugText = $('bugText');
  const bugContact = $('bugContact');
  const donateText = $('donateText');

  if (BUG_CONTACT && bugContact) bugContact.textContent = `제보 보내실 곳: ${BUG_CONTACT}`;
  else if (bugContact) bugContact.style.display = 'none';
  if (donateText) donateText.textContent = DONATE_TEXT;

  const openModal = (m) => m && m.classList.remove('hidden');
  const closeModals = () => {
    if (bugModal) bugModal.classList.add('hidden');
    if (donateModal) donateModal.classList.add('hidden');
  };
  if ($('bugBtn')) $('bugBtn').addEventListener('click', () => openModal(bugModal));
  if ($('donateBtn')) $('donateBtn').addEventListener('click', () => openModal(donateModal));
  document.querySelectorAll('.modal-close').forEach((b) => b.addEventListener('click', closeModals));
  for (const m of [bugModal, donateModal]) {
    if (m) m.addEventListener('click', (e) => { if (e.target === m) closeModals(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModals();
  });

  if ($('bugCopyBtn')) {
    $('bugCopyBtn').addEventListener('click', async () => {
      const body = [
        '[My MultiView 버그 제보]',
        `버전: v${chrome.runtime.getManifest().version}`,
        `로그인 연동: ${currentAuth.loggedIn ? '연동됨' : '비로그인'}`,
        `등록 채널 수: 입력 ${channels.length}개 / 즐겨찾기 ${favorites.list().length}개`,
        `주요 설정: 미리불러오기=${settings.chatPreload}, 호버오디오=${settings.hoverAudio}, 기본화질=${settings.defaultQuality}, 열수=${settings.gridCols}`,
        `내용: ${(bugText && bugText.value.trim()) || '(내용 없음)'}`,
      ].join('\n');
      try {
        await navigator.clipboard.writeText(body);
        $('bugCopyBtn').textContent = '복사됨!';
        setTimeout(() => {
          $('bugCopyBtn').textContent = '진단 정보와 함께 복사';
        }, 1500);
      } catch {
        if (bugText) {
          bugText.select();
          document.execCommand('copy');
        }
      }
    });
  }
})();
