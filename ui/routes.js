// Announcements: the path from pool to network drawn as a flow -- pools, the
// advertisements that select them, the nodes that speak for them, and the BGP
// peers that listen -- with what is wrong with it underneath, and who
// actually answers for each address.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var M = window.MetalLB;
    var K = window.MetalLBKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;
    // Past this many nodes the column shows only the ones that take part.
    var MANY_NODES = 24;

    var state = { ctx: null, model: null, sig: '', error: '', hover: '', graph: null };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        state.error = (err && err.message) || String(err);
        $('error').textContent = state.error;
        $('error').hidden = false;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    // ----- the graph ---------------------------------------------------------

    function graphOf(model) {
        var links = [];
        var seen = {};
        function link(from, to, mode) {
            var key = from + '>' + to + '>' + mode;
            if (seen[key]) return;
            seen[key] = true;
            links.push({ from: from, to: to, mode: mode });
        }

        function speaks(n) {
            return !model.speakersKnown || !!n.speaker;
        }

        var linkedNodes = {};
        model.advertisements.forEach(function (adv) {
            var advId = 'adv:' + adv.mode + ':' + adv.name;
            adv.pools.forEach(function (p) {
                link('pool:' + p.name, advId, adv.mode);
            });
            adv.nodes.filter(speaks).forEach(function (n) {
                link(advId, 'node:' + n.name, adv.mode);
                linkedNodes[n.name] = true;
            });
            if (adv.mode === 'bgp') {
                adv.peers.forEach(function (peer) {
                    peer.nodes.filter(speaks).forEach(function (n) {
                        if (adv.nodes.indexOf(n) < 0) return;
                        link('node:' + n.name, 'peer:' + peer.name, 'bgp');
                    });
                });
            }
        });

        var nodes = model.nodes;
        var hidden = 0;
        if (nodes.length > MANY_NODES) {
            var shown = nodes.filter(function (n) {
                return linkedNodes[n.name] || (n.speaker && !n.speakerReady);
            });
            hidden = nodes.length - shown.length;
            nodes = shown;
        }

        var columns = [
            {
                title: 'Pools',
                hint: 'where the addresses come from',
                items: model.pools.map(function (p) {
                    return { id: 'pool:' + p.name, draw: poolCard(p) };
                }),
            },
            {
                title: 'Advertisements',
                hint: 'how they are announced',
                items: model.advertisements.map(function (a) {
                    return { id: 'adv:' + a.mode + ':' + a.name, draw: advCard(a) };
                }),
            },
            {
                title: 'Nodes',
                hint: 'who speaks for them',
                items: nodes.map(function (n) {
                    return { id: 'node:' + n.name, draw: nodeCard(model, n) };
                }),
                more: hidden ? hidden + ' more node' + (hidden === 1 ? '' : 's') + ' take no part' : '',
            },
        ];
        if (model.peerList.length) {
            columns.push({
                title: 'BGP peers',
                hint: 'who listens',
                items: model.peerList.map(function (p) {
                    return { id: 'peer:' + p.name, draw: peerCard(p) };
                }),
            });
        }
        return { columns: columns, links: links };
    }

    // Everything upstream and downstream of one card.
    function related(graph, id) {
        var lit = {};
        lit[id] = true;
        function walk(at, forward) {
            graph.links.forEach(function (l) {
                var from = forward ? l.from : l.to;
                var to = forward ? l.to : l.from;
                if (from === at && !lit[to]) {
                    lit[to] = true;
                    walk(to, forward);
                }
            });
        }
        walk(id, true);
        walk(id, false);
        return lit;
    }

    // ----- cards -------------------------------------------------------------

    function card(kind, title, onOpen) {
        var node = K.button('', 'fcard is-' + kind, null, onOpen);
        var head = el('span', 'fcard-head');
        add(head, K.icon(kind === 'adv-l2' ? 'l2' : kind === 'adv-bgp' ? 'bgp' : kind), el('span', 'fcard-title', title));
        node.appendChild(head);
        return node;
    }

    function poolCard(p) {
        return function () {
            var node = card('pool', p.name, function () {
                open({ kind: M.KINDS.pools, namespace: p.namespace, name: p.name });
            });
            var fraction = M.share(p.used, p.capacity);
            add(node, el('span', 'fcard-sub', p.used + ' of ' + M.count(p.capacity) + ' in use'), K.meter(fraction, K.fillTone(fraction)));
            if (!p.l2.length && !p.bgp.length) node.appendChild(K.chip('not advertised', 'error', 'alert'));
            return node;
        };
    }

    function advCard(a) {
        return function () {
            var node = card('adv-' + a.mode, a.name, function () {
                open({ kind: a.mode === 'l2' ? M.KINDS.l2 : M.KINDS.bgp, namespace: a.obj.metadata.namespace, name: a.name });
            });
            node.appendChild(K.chip(a.mode === 'l2' ? 'Layer 2' : 'BGP', a.mode));
            var facts = [];
            var selectors = M.dig(a.obj, 'spec.nodeSelectors') || [];
            facts.push(selectors.length ? a.nodes.length + ' selected node' + (a.nodes.length === 1 ? '' : 's') : 'every node');
            if (a.mode === 'l2') {
                facts.push(a.interfaces.length ? 'on ' + a.interfaces.join(', ') : 'any interface');
            } else {
                facts.push(a.peers.length + ' peer' + (a.peers.length === 1 ? '' : 's'));
                if (a.aggregation !== undefined) facts.push('/' + a.aggregation);
                if (a.localPref !== undefined) facts.push('localPref ' + a.localPref);
                if (a.communities.length) facts.push(a.communities.join(' '));
            }
            node.appendChild(el('span', 'fcard-sub', facts.join(' · ')));
            return node;
        };
    }

    function nodeCard(model, n) {
        return function () {
            var node = card('node', n.name, function () {
                open({ kind: M.KINDS.nodes, namespace: '', name: n.name });
            });
            var status;
            if (n.excluded) status = K.chip('excluded', 'muted', null, M.EXCLUDE_LABEL);
            else if (model.speakersKnown && !n.speaker) status = K.chip('no speaker', 'muted');
            else if (model.speakersKnown && !n.speakerReady) status = K.chip('speaker down', 'error', 'alert');
            else if (!n.ready) status = K.chip('node not ready', 'warn', 'alert');
            else status = K.chip('speaking', 'ok', 'check');
            node.appendChild(status);
            if (n.announces) node.appendChild(el('span', 'fcard-sub', 'answers for ' + n.announces + ' address' + (n.announces === 1 ? '' : 'es')));
            return node;
        };
    }

    function peerCard(p) {
        return function () {
            var node = card('peer', p.name, function () {
                open({ kind: M.KINDS.peers, namespace: p.obj.metadata.namespace, name: p.name });
            });
            add(node, el('code', 'fcard-sub', p.address + (p.port && p.port !== 179 ? ':' + p.port : '')));
            var asn = [];
            if (p.myASN) asn.push('AS' + p.myASN);
            if (p.peerASN) asn.push('AS' + p.peerASN);
            if (asn.length) node.appendChild(el('span', 'fcard-sub', asn.join(' ⇄ ')));
            if (p.bfd) node.appendChild(K.chip('BFD ' + p.bfd, 'muted'));
            return node;
        };
    }

    // ----- drawing the flow --------------------------------------------------

    function drawFlow(model) {
        var flow = $('flow');
        flow.textContent = '';
        var graph = graphOf(model);
        state.graph = graph;
        flow.style.setProperty('--columns', String(graph.columns.length));

        var wires = K.svg('svg', { class: 'wires', 'aria-hidden': 'true' });
        flow.appendChild(wires);

        graph.columns.forEach(function (col) {
            var column = el('div', 'fcol');
            var head = el('div', 'fcol-head');
            add(head, el('span', 'fcol-title', col.title), el('span', 'faint', col.hint));
            column.appendChild(head);
            if (col.items.length === 0) column.appendChild(el('div', 'fcol-empty', 'none'));
            col.items.forEach(function (item) {
                var node = item.draw();
                node.dataset.id = item.id;
                column.appendChild(node);
            });
            if (col.more) column.appendChild(el('div', 'fcol-empty', col.more));
            flow.appendChild(column);
        });
        drawWires();
        light(state.hover);
    }

    function drawWires() {
        var flow = $('flow');
        var wires = flow.querySelector('.wires');
        if (!wires || !state.graph) return;
        wires.textContent = '';
        var box = flow.getBoundingClientRect();
        wires.setAttribute('width', String(box.width));
        wires.setAttribute('height', String(flow.scrollHeight));

        var at = {};
        flow.querySelectorAll('.fcard').forEach(function (node) {
            var r = node.getBoundingClientRect();
            at[node.dataset.id] = { left: r.left - box.left, right: r.right - box.left, mid: r.top - box.top + r.height / 2 };
        });

        state.graph.links.forEach(function (l) {
            var a = at[l.from];
            var b = at[l.to];
            if (!a || !b) return;
            var x1 = a.right;
            var x2 = b.left;
            var bend = Math.max(24, (x2 - x1) / 2);
            var d = 'M' + x1 + ' ' + a.mid + ' C' + (x1 + bend) + ' ' + a.mid + ' ' + (x2 - bend) + ' ' + b.mid + ' ' + x2 + ' ' + b.mid;
            var path = K.svg('path', { d: d, class: 'wire ' + l.mode });
            path.dataset.from = l.from;
            path.dataset.to = l.to;
            wires.appendChild(path);
        });
        light(state.hover);
    }

    function light(id) {
        var flow = $('flow');
        var lit = id && state.graph ? related(state.graph, id) : null;
        flow.classList.toggle('tracing', !!lit);
        flow.querySelectorAll('.fcard').forEach(function (node) {
            node.classList.toggle('lit', !!lit && !!lit[node.dataset.id]);
        });
        flow.querySelectorAll('.wire').forEach(function (path) {
            var on = !!lit && lit[path.dataset.from] && lit[path.dataset.to];
            path.classList.toggle('lit', !!on);
        });
    }

    function hover(event) {
        var node = event.target.closest && event.target.closest('.fcard');
        var id = node ? node.dataset.id : '';
        if (id === state.hover) return;
        state.hover = id;
        light(id);
    }

    // ----- findings and answers ----------------------------------------------

    function drawFindings(model) {
        var box = $('findings');
        box.textContent = '';
        var head = el('h2', 'section-title', 'Findings');
        box.appendChild(head);
        if (model.findings.length === 0) {
            var fine = el('div', 'all-good');
            add(fine, K.icon('check'), el('span', '', 'Every pool is announced, and every advertisement reaches a node that can speak for it.'));
            box.appendChild(fine);
            return;
        }
        var list = el('ul', 'issues');
        model.findings.forEach(function (f) {
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

    function nodeList(names) {
        var cell = el('span');
        names.forEach(function (name, i) {
            if (i > 0) cell.appendChild(document.createTextNode(', '));
            cell.appendChild(
                K.link(name, function () {
                    open({ kind: M.KINDS.nodes, namespace: '', name: name });
                }),
            );
        });
        return cell;
    }

    function drawAnswers(model) {
        var box = $('answers');
        box.textContent = '';
        box.appendChild(el('h2', 'section-title', 'Who answers for each address'));

        var rows = [];
        model.allocations.forEach(function (at) {
            rows.push(at);
        });
        rows.sort(function (a, b) {
            if (a.ip.v !== b.ip.v) return a.ip.v - b.ip.v;
            return a.ip.n < b.ip.n ? -1 : a.ip.n > b.ip.n ? 1 : 0;
        });
        if (rows.length === 0) {
            box.appendChild(el('p', 'faint', 'No LoadBalancer service holds an address yet.'));
            return;
        }
        if (!model.kinds.l2Status) {
            box.appendChild(
                el('p', 'faint small', 'This MetalLB does not publish ServiceL2Status objects (they came with 0.14), so for Layer 2 the table shows which nodes could answer rather than the one that does.'),
            );
        }

        var wrap = el('div', 'table-wrap');
        var table = el('table', 'answers-table');
        var thead = el('thead');
        var tr = el('tr');
        ['Address', 'Service', 'Pool', 'Announced', 'From'].forEach(function (h) {
            tr.appendChild(el('th', '', h));
        });
        thead.appendChild(tr);
        table.appendChild(thead);
        var body = el('tbody');

        rows.forEach(function (at) {
            var svc = at.services[0];
            var hops = M.route(model, svc, at.pool);
            var row = el('tr');
            var ip = el('td');
            ip.appendChild(el('code', '', at.text));
            row.appendChild(ip);

            var who = el('td');
            at.services.forEach(function (s, i) {
                if (i > 0) who.appendChild(document.createTextNode(', '));
                who.appendChild(
                    K.link(s.namespace + '/' + s.name, function () {
                        open(K.serviceRef(s));
                    }),
                );
            });
            row.appendChild(who);
            row.appendChild(el('td', '', at.pool.name));

            var how = el('td');
            var from = el('td');
            if (hops.length === 0) {
                how.appendChild(K.chip('nowhere', 'error', 'alert'));
            }
            hops.forEach(function (hop) {
                how.appendChild(K.chip(hop.mode === 'l2' ? 'L2' : 'BGP', hop.mode));
                var line = el('div', 'from-line');
                if (hop.known) {
                    line.appendChild(
                        nodeList(
                            hop.nodes.map(function (n) {
                                return n.name;
                            }),
                        ),
                    );
                } else if (hop.candidates.length) {
                    add(line, el('span', 'faint', hop.mode === 'l2' ? 'one of ' : ''), nodeList(hop.candidates.slice(0, 4).map(function (n) {
                        return n.name;
                    })));
                    if (hop.candidates.length > 4) line.appendChild(el('span', 'faint', ' +' + (hop.candidates.length - 4)));
                } else {
                    line.appendChild(el('span', 'error-text', 'no node'));
                }
                if (hop.mode === 'bgp' && hop.peers.length) {
                    line.appendChild(
                        el(
                            'span',
                            'faint',
                            ' → ' +
                                hop.peers
                                    .map(function (p) {
                                        return p.name;
                                    })
                                    .join(', '),
                        ),
                    );
                }
                from.appendChild(line);
            });
            row.appendChild(how);
            row.appendChild(from);
            body.appendChild(row);
        });
        table.appendChild(body);
        wrap.appendChild(table);
        box.appendChild(wrap);
    }

    // ----- putting it together -----------------------------------------------

    function drawEmpty(model) {
        var box = $('empty');
        box.textContent = '';
        box.hidden = false;
        var art = el('div', 'empty-art');
        art.appendChild(K.icon('share'));
        add(box, art, el('h2', '', 'Nothing to announce'), el('p', 'faint', 'MetalLB is not installed in ' + state.ctx.contextName + '.'));
        if (model.missing) box.appendChild(el('p', 'faint small', model.missing));
    }

    function render() {
        var model = state.model;
        var where = state.ctx.contextName;
        if (model.version) where += ' · MetalLB ' + model.version;
        $('where').textContent = where;
        if (!model.installed) {
            $('body').hidden = true;
            drawEmpty(model);
            return;
        }
        $('empty').hidden = true;
        $('body').hidden = false;
        drawFlow(model);
        drawFindings(model);
        drawAnswers(model);
    }

    function tick() {
        M.load(sdk)
            .then(function (model) {
                $('error').hidden = true;
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

    $('logo').appendChild(K.icon('share'));
    var key = $('key');
    add(key, K.chip('Layer 2', 'l2', 'l2'), K.chip('BGP', 'bgp', 'bgp'));
    $('top-actions').appendChild(
        K.button('Address space', 'ghost', 'pool', function () {
            sdk.openView('space').catch(fail);
        }),
    );
    $('flow').addEventListener('pointerover', hover);
    $('flow').addEventListener('focusin', hover);
    $('flow').addEventListener('pointerleave', function () {
        state.hover = '';
        light('');
    });
    if (typeof ResizeObserver === 'function') new ResizeObserver(drawWires).observe($('flow'));

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            $('where').textContent = context.contextName;
            tick();
        })
        .catch(fail);
})();
