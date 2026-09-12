// Address space: every pool as a seat map of its addresses, coloured by the
// namespace holding each one, with the route any address takes out of the
// cluster one click away -- and the services still waiting for an address
// at the top, with what to do about each.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var M = window.MetalLB;
    var K = window.MetalLBKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;

    var state = {
        ctx: null,
        model: null,
        sig: '',
        error: '',
        query: '',
        selected: '',
        // Scroll the selected seat into view once, after a search picked it.
        reveal: false,
        cols: 32,
        cell: 13,
        notice: '',
    };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    function fail(err) {
        state.error = (err && err.message) || String(err);
        drawError();
    }

    function drawError() {
        $('error').textContent = state.error;
        $('error').hidden = !state.error;
    }

    // A section with a control the user is working in is left alone by the
    // poll until they are done: redrawing it would snatch the select out of
    // their hand. It is marked stale and caught up when focus leaves it.
    var stale = {};

    function held(section, force) {
        if (force) return false;
        var active = document.activeElement;
        if (active && active !== document.body && section.contains(active)) {
            stale[section.id] = true;
            return true;
        }
        return false;
    }

    // ----- search ------------------------------------------------------------

    // What the query picks out: an address if it is one, otherwise every
    // address whose service, namespace or text contains it.
    function searchHits(model) {
        var q = state.query.trim().toLowerCase();
        if (!q) return null;
        var hits = new Set();
        model.allocations.forEach(function (at) {
            var text = at.text.toLowerCase();
            var match =
                text.indexOf(q) === 0 ||
                at.pool.name.toLowerCase().indexOf(q) >= 0 ||
                at.services.some(function (s) {
                    return s.name.toLowerCase().indexOf(q) >= 0 || s.namespace.toLowerCase().indexOf(q) >= 0;
                });
            if (match) hits.add(at.key);
        });
        return hits;
    }

    function onQuery() {
        state.query = $('query').value;
        var ip = M.parseIP(state.query);
        if (ip && state.model) {
            var key = M.ipKey(ip);
            var inPool = state.model.pools.some(function (p) {
                return M.contains(p, ip);
            });
            if (inPool) {
                state.selected = key;
                state.reveal = true;
            }
        }
        render();
    }

    // ----- the hero ----------------------------------------------------------

    function stat(label, big, small, extra) {
        var tile = el('div', 'stat');
        add(tile, el('div', 'stat-label', label));
        var row = el('div', 'stat-row');
        if (extra && extra.graphic) row.appendChild(extra.graphic);
        var nums = el('div', 'stat-nums');
        add(nums, el('div', 'stat-big', big));
        if (small) nums.appendChild(small);
        row.appendChild(nums);
        tile.appendChild(row);
        if (extra && extra.foot) tile.appendChild(extra.foot);
        return tile;
    }

    function drawHero(model) {
        var hero = $('hero');
        hero.textContent = '';
        hero.hidden = false;

        var capacity = 0n;
        var used = 0;
        model.pools.forEach(function (p) {
            capacity += p.capacity;
            used += p.used;
        });
        var fraction = M.share(used, capacity);
        add(
            hero,
            stat('Addresses in use', String(used), el('div', 'stat-small', 'of ' + M.count(capacity) + ' in ' + model.pools.length + (model.pools.length === 1 ? ' pool' : ' pools')), {
                graphic: K.ring(fraction, 58, K.fillTone(fraction), M.percent(fraction) + ' in use'),
                foot: el('div', 'stat-foot', M.percent(fraction) + ' of the address space'),
            }),
        );

        var exposed = model.services.length - model.pending.length;
        var waiting = model.pending.length;
        var svcFoot = el('div', 'stat-foot ' + (waiting ? 'warn' : 'ok'));
        svcFoot.appendChild(K.icon(waiting ? 'alert' : 'check'));
        svcFoot.appendChild(el('span', '', waiting ? waiting + (waiting === 1 ? ' is' : ' are') + ' waiting for an address' : model.services.length ? 'every one has an address' : 'no LoadBalancer services yet'));
        add(hero, stat('Services exposed', String(exposed), el('div', 'stat-small', 'LoadBalancer services with an address'), { foot: svcFoot }));

        var nodesTile;
        if (model.speakersKnown) {
            var ready = model.nodes.filter(function (n) {
                return n.speakerReady;
            }).length;
            var withSpeaker = model.nodes.filter(function (n) {
                return n.speaker;
            }).length;
            var dots = el('div', 'node-dots');
            model.nodes.slice(0, 40).forEach(function (n) {
                var dot = el('i', n.excluded ? 'excluded' : !n.speaker ? 'none' : n.speakerReady ? 'ok' : 'error');
                dot.title = n.name + ' — ' + (n.excluded ? 'excluded from load balancers' : !n.speaker ? 'no speaker' : n.speakerReady ? 'speaker ready' : 'speaker not ready');
                dots.appendChild(dot);
            });
            nodesTile = stat('Speakers ready', ready + ' / ' + withSpeaker, el('div', 'stat-small', 'on ' + model.nodes.length + (model.nodes.length === 1 ? ' node' : ' nodes')), { foot: dots });
        } else {
            nodesTile = stat('Speakers', '—', el('div', 'stat-small', 'no speaker pods found'), {
                foot: el('div', 'stat-foot faint', 'Looked for pods labelled app.kubernetes.io/name=metallb or app=metallb.'),
            });
        }
        hero.appendChild(nodesTile);

        var l2 = model.advertisements.filter(function (a) {
            return a.mode === 'l2';
        }).length;
        var bgp = model.advertisements.length - l2;
        var modes = el('div', 'modes');
        modes.appendChild(K.chip('Layer 2 · ' + l2, l2 ? 'l2' : 'muted', 'l2'));
        modes.appendChild(K.chip('BGP · ' + bgp, bgp ? 'bgp' : 'muted', 'bgp'));
        if (model.peerList.length) modes.appendChild(K.chip(model.peerList.length + (model.peerList.length === 1 ? ' peer' : ' peers'), 'muted', 'peer'));
        var routes = K.button('See how it is announced', 'ghost small', 'arrow', function () {
            sdk.openView('routes').catch(fail);
        });
        var tile = el('div', 'stat');
        add(tile, el('div', 'stat-label', 'Announced by'), modes, routes);
        hero.appendChild(tile);
    }

    // ----- what needs attention ---------------------------------------------

    function fixForPending(model, svc) {
        // A service meant for another load balancer class is not ours to fix.
        if (!state.ctx.write || (svc.diagnosis.tone === 'info' && svc.lbClass)) return null;
        var box = el('div', 'fix');
        var picker = K.poolPicker(model, svc.requestedPool, svc);
        var go = K.button('Use this pool', 'primary small', null, function () {
            K.apply(sdk, K.serviceRef(svc), K.patches.movePool(model, svc, picker.value))
                .then(function (done) {
                    if (done) notice('Asked MetalLB to serve ' + svc.name + ' from ' + (picker.value || 'any pool') + '.');
                })
                .catch(fail);
        });
        add(box, picker, go);
        return box;
    }

    function drawAttention(model, force) {
        var box = $('attention');
        if (held(box, force)) return;
        stale.attention = false;
        box.textContent = '';
        var findings = model.findings.filter(function (f) {
            return f.tone !== 'info';
        });
        box.hidden = model.pending.length === 0 && findings.length === 0 && !state.notice;
        if (box.hidden) return;

        if (state.notice) {
            var note = el('div', 'notice');
            add(note, K.icon('check'), el('span', '', state.notice));
            box.appendChild(note);
        }
        if (model.pending.length === 0 && findings.length === 0) return;

        var head = el('div', 'attention-head');
        add(head, K.icon('alert'), el('h2', '', 'Needs attention'), el('span', 'count', String(model.pending.length + findings.length)));
        box.appendChild(head);

        var list = el('ul', 'issues');
        model.pending.forEach(function (svc) {
            var item = el('li', 'issue ' + svc.diagnosis.tone);
            var main = el('div', 'issue-main');
            var title = el('div', 'issue-title');
            add(
                title,
                K.icon('service'),
                K.link(svc.namespace + '/' + svc.name, function () {
                    open(K.serviceRef(svc));
                }),
                el('span', 'faint', ' has no address'),
            );
            add(main, title, el('div', 'issue-text', svc.diagnosis.text));
            item.appendChild(main);
            var fix = fixForPending(model, svc);
            if (fix) item.appendChild(fix);
            list.appendChild(item);
        });
        findings.forEach(function (f) {
            var item = el('li', 'issue ' + f.tone);
            var main = el('div', 'issue-main');
            add(main, el('div', 'issue-text', f.text));
            item.appendChild(main);
            if (f.ref) {
                item.appendChild(
                    K.button('Open', 'ghost small', 'open', function () {
                        open(f.ref);
                    }),
                );
            }
            list.appendChild(item);
        });
        box.appendChild(list);
    }

    function notice(text) {
        state.notice = text;
        drawAttention(state.model, true);
        setTimeout(function () {
            if (state.notice === text) {
                state.notice = '';
                drawAttention(state.model);
            }
        }, 6000);
    }

    // ----- the pools ---------------------------------------------------------

    function poolTags(pool) {
        var tags = el('div', 'pool-tags');
        tags.appendChild(pool.autoAssign ? K.chip('auto-assign', 'ok', 'check') : K.chip('on request only', 'info', 'pin', 'autoAssign: false — only services that ask for this pool get its addresses'));
        var v4 = pool.families.indexOf(4) >= 0;
        var v6 = pool.families.indexOf(6) >= 0;
        if (v4 || v6) tags.appendChild(K.chip(v4 && v6 ? 'IPv4 + IPv6' : v6 ? 'IPv6' : 'IPv4', 'muted'));
        if (pool.l2.length) tags.appendChild(K.chip('L2 · ' + pool.l2.join(', '), 'l2', 'l2'));
        if (pool.bgp.length) tags.appendChild(K.chip('BGP · ' + pool.bgp.join(', '), 'bgp', 'bgp'));
        if (!pool.l2.length && !pool.bgp.length) tags.appendChild(K.chip('not advertised', 'error', 'alert', 'No L2Advertisement or BGPAdvertisement selects this pool'));
        if (pool.onlyNamespaces.length) tags.appendChild(K.chip('only ' + pool.onlyNamespaces.join(', '), 'muted', null, 'serviceAllocation.namespaces'));
        if (pool.namespaceSelectors.length || pool.serviceSelectors.length) tags.appendChild(K.chip('narrowed by selector', 'muted', null, 'serviceAllocation selectors'));
        if (pool.priority !== null) tags.appendChild(K.chip('priority ' + pool.priority, 'muted'));
        return tags;
    }

    function drawPools(model) {
        var root = $('pools');
        // The seat under the pointer is about to be replaced, and would never
        // say it was left.
        tip.hidden = true;
        root.textContent = '';
        var hits = searchHits(model);
        var q = state.query.trim().toLowerCase();

        if (model.pools.length === 0) {
            root.appendChild(noPools());
            return;
        }

        var shown = 0;
        model.pools.forEach(function (pool) {
            var nameHit = q && pool.name.toLowerCase().indexOf(q) >= 0;
            var anyHit = false;
            if (hits) {
                hits.forEach(function (key) {
                    if (model.allocations.get(key).pool === pool) anyHit = true;
                });
            }
            var selectedHere = state.selected && poolOfKey(model, state.selected) === pool;
            var faded = hits && !nameHit && !anyHit && !selectedHere;

            var fraction = M.share(pool.used, pool.capacity);
            var card = el('article', 'pool' + (faded ? ' faded' : ''));
            card.dataset.pool = pool.name;

            var head = el('header', 'pool-head');
            var id = el('div', 'pool-id');
            var badge = el('span', 'pool-badge');
            badge.appendChild(K.icon('pool'));
            var names = el('div');
            add(
                names,
                K.link(
                    pool.name,
                    function () {
                        open({ kind: M.KINDS.pools, namespace: pool.namespace, name: pool.name });
                    },
                    'Open the pool',
                ),
                el('div', 'faint small', pool.namespace),
            );
            names.firstChild.classList.add('pool-name');
            add(id, badge, names);

            var use = el('div', 'pool-use');
            var nums = el('div', 'pool-nums');
            add(nums, el('strong', '', String(pool.used)), el('span', 'faint', ' / ' + M.count(pool.capacity)), el('span', 'pct ' + K.fillTone(fraction), M.percent(fraction)));
            add(use, nums, K.meter(fraction, K.fillTone(fraction)));

            add(head, id, poolTags(pool), use);
            card.appendChild(head);

            card.appendChild(K.seatMap(pool, model, { cols: state.cols, cell: state.cell, selected: state.selected, hits: hits && !nameHit ? hits : null }));
            card.appendChild(K.legend(pool, model));
            root.appendChild(card);
            if (!faded) shown++;
        });

        if (hits && shown === 0) {
            var none = el('p', 'faint nothing', 'Nothing in any pool matches "' + state.query.trim() + '".');
            root.insertBefore(none, root.firstChild);
        }

        if (state.reveal) {
            state.reveal = false;
            var target = root.querySelector('.seat.sel');
            if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }

    function poolOfKey(model, key) {
        var at = model.allocations.get(key);
        if (at) return at.pool;
        var ip = K.keyToIP(key);
        return (
            model.pools.find(function (p) {
                return M.contains(p, ip);
            }) || null
        );
    }

    // The pool a seat on the page belongs to.
    function poolOfSeat(seat) {
        var card = seat.closest('.pool');
        return card && state.model ? state.model.poolNamed(card.dataset.pool) : null;
    }

    function pick(model, seat) {
        if (seat.classList.contains('slice')) {
            // A slice of a big range: the first address in use inside it.
            var from = M.parseIP(seat.dataset.from);
            var to = M.parseIP(seat.dataset.to);
            var found = '';
            model.allocations.forEach(function (at) {
                if (!found && at.ip.v === from.v && at.ip.n >= from.n && at.ip.n <= to.n) found = at.key;
            });
            if (!found) return;
            state.selected = found;
        } else {
            state.selected = state.selected === seat.dataset.key ? '' : seat.dataset.key;
        }
        render(true);
        // Stacked on a narrow pane, the inspector has just moved above the
        // pools; take the reader to it.
        if (state.selected && window.matchMedia('(max-width: 980px)').matches) {
            $('inspector').scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    }

    function noPools() {
        var box = el('div', 'getting-started');
        add(
            box,
            el('h2', '', 'No address pools yet'),
            el('p', '', 'MetalLB is installed, but it has nothing to hand out until it has an IPAddressPool — and nothing outside the cluster will find those addresses until an advertisement announces them. The smallest working setup is these two objects:'),
        );
        var pre = el('pre', 'snippet');
        pre.textContent = [
            'apiVersion: metallb.io/v1beta1',
            'kind: IPAddressPool',
            'metadata:',
            '  name: default',
            '  namespace: ' + (state.model.namespace || 'metallb-system'),
            'spec:',
            '  addresses:',
            '    - 192.168.1.240-192.168.1.250',
            '---',
            'apiVersion: metallb.io/v1beta1',
            'kind: L2Advertisement',
            'metadata:',
            '  name: default',
            '  namespace: ' + (state.model.namespace || 'metallb-system'),
        ].join('\n');
        box.appendChild(pre);
        box.appendChild(
            K.button('MetalLB configuration docs', 'ghost', 'open', function () {
                sdk.openUrl('https://metallb.io/configuration/').catch(fail);
            }),
        );
        return box;
    }

    // ----- the inspector -----------------------------------------------------

    function drawInspector(model, force) {
        var box = $('inspector');
        if (held(box, force)) return;
        stale.inspector = false;
        box.textContent = '';

        var at = state.selected ? model.allocations.get(state.selected) : null;
        if (state.selected && at) {
            inspectAllocation(box, model, at);
        } else if (state.selected && poolOfKey(model, state.selected)) {
            inspectFree(box, model, poolOfKey(model, state.selected), K.keyToIP(state.selected));
        } else {
            state.selected = '';
            directory(box, model);
        }
        box.classList.toggle('active', !!state.selected);
    }

    function inspectorHead(box, title, closable) {
        var head = el('div', 'insp-head');
        head.appendChild(el('h2', '', title));
        if (closable) {
            var close = K.button('', 'icon-button', null, function () {
                state.selected = '';
                render(true);
            });
            close.textContent = '×';
            close.title = 'Back to every address';
            close.setAttribute('aria-label', 'Close');
            head.appendChild(close);
        }
        box.appendChild(head);
    }

    function inspectAllocation(box, model, at) {
        inspectorHead(box, 'Route of an address', true);
        box.appendChild(
            K.route(model, at, {
                open: open,
            }),
        );

        var svc = at.services[0];
        var tools = el('div', 'insp-tools');
        tools.appendChild(
            K.button('Service YAML', 'ghost small', 'edit', function () {
                sdk.edit(K.serviceRef(svc)).catch(fail);
            }),
        );
        box.appendChild(tools);

        if (!state.ctx.write || at.services.length !== 1) return;

        var actions = el('div', 'insp-actions');
        var pinned = svc.requestedIPs.length > 0;
        var pin = el('div', 'action-row');
        add(
            pin,
            el('div', 'action-text', pinned ? 'This address is pinned: the service keeps it even if it is recreated elsewhere.' : 'Keep this address even if the service is recreated.'),
            K.button(pinned ? 'Unpin' : 'Pin address', 'small', 'pin', function () {
                var patch = pinned ? K.patches.unpin(model, svc) : K.patches.pin(model, svc);
                K.apply(sdk, K.serviceRef(svc), patch)
                    .then(function (done) {
                        if (done) notice((pinned ? 'Unpinned ' : 'Pinned ') + at.text + ' for ' + svc.name + '.');
                    })
                    .catch(fail);
            }),
        );
        actions.appendChild(pin);

        if (model.pools.length > 1) {
            var move = el('div', 'action-row');
            var picker = K.poolPicker(model, svc.requestedPool, svc);
            add(
                move,
                el('div', 'action-text', 'Serve it from another pool. It gets a new address from there, and this one goes back.'),
                picker,
                K.button('Move', 'small', 'arrow', function () {
                    K.apply(sdk, K.serviceRef(svc), K.patches.movePool(model, svc, picker.value))
                        .then(function (done) {
                            if (done) notice('Asked MetalLB to move ' + svc.name + ' to ' + (picker.value || 'any pool') + '.');
                        })
                        .catch(fail);
                }),
            );
            actions.appendChild(move);
        }
        box.appendChild(actions);
    }

    function inspectFree(box, model, pool, ip) {
        var text = M.formatIP(ip);
        var buggy = pool.avoidBuggy && M.isBuggy(ip);
        inspectorHead(box, buggy ? 'Skipped address' : 'Free address', true);

        var card = el('div', 'free-card');
        add(card, el('code', 'big-ip', text));
        var line = el('div', 'faint');
        add(
            line,
            'in pool ',
            K.link(pool.name, function () {
                open({ kind: M.KINDS.pools, namespace: pool.namespace, name: pool.name });
            }),
        );
        card.appendChild(line);
        box.appendChild(card);

        if (buggy) {
            box.appendChild(el('p', 'insp-note', 'avoidBuggyIPs is on for this pool, so addresses ending in .0 and .255 are never handed out.'));
            return;
        }
        if (!state.ctx.write) return;
        var candidates = model.services.filter(function (s) {
            return M.poolServes(pool, s) && (s.ips.length > 0 || s.hostnames.length === 0);
        });
        if (candidates.length === 0) {
            box.appendChild(el('p', 'insp-note', 'No LoadBalancer service can use this pool.'));
            return;
        }

        var give = el('div', 'insp-actions');
        give.appendChild(el('div', 'action-text', 'Give this address to a service. It is asked for by annotation; MetalLB moves the service here and returns its old address.'));
        var select = el('select', 'picker');
        // The ones waiting for an address first: they are why anybody is here.
        candidates
            .slice()
            .sort(function (a, b) {
                return (a.ips.length > 0) - (b.ips.length > 0) || a.key.localeCompare(b.key);
            })
            .forEach(function (s) {
                var option = el('option', '', s.namespace + '/' + s.name + (s.ips.length ? '  (' + s.ips.join(', ') + ')' : '  — waiting'));
                option.value = s.key;
                select.appendChild(option);
            });
        var row = el('div', 'action-row');
        add(
            row,
            select,
            K.button('Give address', 'primary small', 'pin', function () {
                var svc = candidates.find(function (s) {
                    return s.key === select.value;
                });
                if (!svc) return;
                K.apply(sdk, K.serviceRef(svc), K.patches.giveAddress(model, svc, text, pool))
                    .then(function (done) {
                        if (done) notice('Asked MetalLB to give ' + text + ' to ' + svc.name + '.');
                    })
                    .catch(fail);
            }),
        );
        give.appendChild(row);
        box.appendChild(give);
    }

    function directory(box, model) {
        inspectorHead(box, 'Every address in use', false);
        var hits = searchHits(model);
        var rows = [];
        model.allocations.forEach(function (at) {
            if (!hits || hits.has(at.key)) rows.push(at);
        });
        rows.sort(function (a, b) {
            if (a.ip.v !== b.ip.v) return a.ip.v - b.ip.v;
            return a.ip.n < b.ip.n ? -1 : a.ip.n > b.ip.n ? 1 : 0;
        });

        if (rows.length === 0) {
            box.appendChild(el('p', 'insp-note', hits ? 'No address in use matches.' : model.pools.length ? 'No LoadBalancer service holds an address yet.' : 'Nothing to list until there is a pool.'));
            return;
        }
        box.appendChild(el('p', 'insp-note', 'Pick one — here or on a map — to see how it reaches the outside.'));
        var list = el('ul', 'directory');
        rows.forEach(function (at) {
            var item = el('li');
            var b = K.button('', 'dir-row', null, function () {
                state.selected = at.key;
                state.reveal = true;
                render(true);
            });
            var dot = el('i', 'dot');
            dot.style.background = model.colors[at.services[0].namespace];
            add(
                b,
                dot,
                el('code', 'dir-ip', at.text),
                el(
                    'span',
                    'dir-who',
                    at.services
                        .map(function (s) {
                            return s.name;
                        })
                        .join(', '),
                ),
                el('span', 'dir-ns faint', at.services[0].namespace),
            );
            item.appendChild(b);
            list.appendChild(item);
        });
        box.appendChild(list);
    }

    // ----- not installed -----------------------------------------------------

    function drawEmpty(model) {
        var box = $('empty');
        box.textContent = '';
        box.hidden = false;
        var art = el('div', 'empty-art');
        art.appendChild(K.icon('logo'));
        add(
            box,
            art,
            el('h2', '', 'MetalLB is not installed in ' + state.ctx.contextName),
            el('p', 'faint', 'This cluster does not serve IPAddressPools, which every MetalLB install has. LoadBalancer services here get their addresses from something else, or not at all.'),
        );
        if (model.missing) box.appendChild(el('p', 'faint small', model.missing));
        box.appendChild(
            K.button('How to install MetalLB', 'primary', 'open', function () {
                sdk.openUrl('https://metallb.io/installation/').catch(fail);
            }),
        );
    }

    // ----- putting it together -----------------------------------------------

    // force is for a redraw the user asked for by clicking; a poll's redraw
    // leaves a section they are working in alone.
    function render(force) {
        var model = state.model;
        if (!model) return;
        drawError();

        var where = state.ctx.contextName;
        if (model.version) where += ' · MetalLB ' + model.version;
        if (model.namespace) where += ' in ' + model.namespace;
        $('where').textContent = where;

        if (!model.installed) {
            drawEmpty(model);
            $('hero').hidden = true;
            $('attention').hidden = true;
            $('layout').hidden = true;
            return;
        }
        $('empty').hidden = true;
        $('layout').hidden = false;
        drawHero(model);
        drawAttention(model, force);
        drawPools(model);
        drawInspector(model, force);
    }

    function measure() {
        // A pool card's padding and border come off the width its map gets.
        var fit = K.fitSeats(($('pools').clientWidth || window.innerWidth) - 40);
        if (fit.cols !== state.cols || fit.cell !== state.cell) {
            state.cols = fit.cols;
            state.cell = fit.cell;
            if (state.model && state.model.installed) drawPools(state.model);
        }
    }

    function tick() {
        M.load(sdk)
            .then(function (model) {
                if (state.error) {
                    state.error = '';
                    drawError();
                }
                if (model.sig !== state.sig) {
                    state.model = model;
                    state.sig = model.sig;
                    render();
                }
            })
            .catch(fail)
            .then(function () {
                setTimeout(tick, POLL);
            });
    }

    // One tip and one click handler for every seat on the page, however often
    // the maps under them are redrawn.
    var tip = K.tooltip($('pools'), function (seat, into) {
        var pool = poolOfSeat(seat);
        return pool ? K.describeSeat(state.model, pool, seat, into) : false;
    });
    $('pools').addEventListener('click', function (event) {
        var seat = event.target.closest && event.target.closest('.seat');
        if (seat && state.model) pick(state.model, seat);
    });

    $('logo').appendChild(K.icon('logo'));
    $('search-icon').appendChild(K.icon('search'));
    $('query').addEventListener('input', onQuery);
    $('query').addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
            $('query').value = '';
            onQuery();
        }
    });
    document.addEventListener('keydown', function (event) {
        if (event.key === '/' && document.activeElement === document.body) {
            event.preventDefault();
            $('query').focus();
        }
    });
    document.addEventListener('focusout', function () {
        // A held section catches up once focus has left it altogether.
        setTimeout(function () {
            if (!state.model || !state.model.installed) return;
            if (stale.attention) drawAttention(state.model);
            if (stale.inspector) drawInspector(state.model);
        }, 0);
    });
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(document.body);

    // The inspector is as wide as it was left: the width is kept in the
    // frame's hash, which outlives the page when its tab is switched away.
    var keptWidth = /(?:^#|&)inspector=(\d+)/.exec(location.hash || '');
    $('inspector').parentNode.insertBefore(
        K.grip({
            panel: $('inspector'),
            prop: '--inspector-w',
            min: 280,
            room: 420,
            initial: keptWidth ? Number(keptWidth[1]) : 0,
            label: 'Resize the inspector',
            onResize: function (px, done) {
                // The seat maps are fitted to the room the pools have left.
                measure();
                if (!done) return;
                try {
                    history.replaceState(null, '', '#' + (px ? 'inspector=' + px : ''));
                } catch (e) {
                    // A sandboxed frame may refuse; the inspector still resizes.
                }
            },
        }),
        $('inspector'),
    );

    var routes = K.button('Announcements', 'ghost', 'share', function () {
        sdk.openView('routes').catch(fail);
    });
    $('top-actions').appendChild(routes);

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            $('where').textContent = context.contextName;
            measure();
            tick();
        })
        .catch(fail);
})();
