// A Service's MetalLB panel: the address it holds and the path that address
// takes -- pool, advertisement, the node answering for it -- with the pool and
// the address one control away. A service that is not a LoadBalancer gets one
// line saying so, and an offer to make it one.
(function () {
    'use strict';

    var sdk = window.k8sdockside;
    var M = window.MetalLB;
    var K = window.MetalLBKit;
    var el = K.el;
    var add = K.add;
    var POLL = 5000;

    var state = { ctx: null, sig: '', installed: null };

    var $ = function (id) {
        return document.getElementById(id);
    };

    function fail(err) {
        $('error').textContent = (err && err.message) || String(err);
        $('error').hidden = false;
    }

    function open(ref) {
        sdk.open(ref).catch(fail);
    }

    function held() {
        var active = document.activeElement;
        return active && active !== document.body && $('root').contains(active);
    }

    function apply(svc, patch, what) {
        K.apply(sdk, K.serviceRef(svc), patch)
            .then(function (done) {
                if (done) flash(what);
            })
            .catch(fail);
    }

    function flash(text) {
        var note = el('div', 'notice');
        add(note, K.icon('check'), el('span', '', text));
        $('root').insertBefore(note, $('root').firstChild);
        setTimeout(function () {
            note.remove();
        }, 5000);
    }

    // ----- not a LoadBalancer ------------------------------------------------

    function drawPlain(obj) {
        var root = $('root');
        root.textContent = '';
        var spec = obj.spec || {};
        var type = spec.type || 'ClusterIP';
        var line = el('div', 'plain');
        line.appendChild(K.icon('info'));
        var text = el('span', '');
        if (state.installed === false) {
            text.textContent = 'MetalLB is not installed in this cluster.';
        } else {
            text.textContent = 'A ' + type + ' service. MetalLB only gives addresses to LoadBalancer services.';
        }
        line.appendChild(text);
        // A headless service has no cluster IP to balance, and an ExternalName
        // one is only a DNS alias.
        var convertible = (type === 'ClusterIP' && spec.clusterIP !== 'None') || type === 'NodePort';
        if (state.ctx.write && state.installed && convertible) {
            line.appendChild(
                K.button('Make it a LoadBalancer', 'small', 'arrow', function () {
                    var svc = M.buildService(obj);
                    apply(svc, K.patches.makeLoadBalancer(), 'Asked for ' + svc.name + ' to become a LoadBalancer.');
                }),
            );
        }
        root.appendChild(line);
    }

    // ----- a LoadBalancer ----------------------------------------------------

    function hopStrip(model, svc, pool) {
        var strip = el('div', 'hops');
        function hop(iconName, label, value, tone) {
            var node = el('span', 'hop' + (tone ? ' ' + tone : ''));
            add(node, K.icon(iconName), el('span', 'hop-label', label));
            if (value) node.appendChild(value);
            strip.appendChild(node);
        }
        function arrow() {
            strip.appendChild(K.icon('arrow', 'hop-arrow'));
        }
        hop(
            'pool',
            'pool',
            K.link(pool.name, function () {
                open({ kind: M.KINDS.pools, namespace: pool.namespace, name: pool.name });
            }),
        );
        var hops = M.route(model, svc, pool);
        if (hops.length === 0) {
            arrow();
            hop('alert', 'not advertised', null, 'error');
            return strip;
        }
        hops.forEach(function (h) {
            arrow();
            hop(
                h.mode,
                h.mode === 'l2' ? 'L2' : 'BGP',
                K.link(h.adv.name, function () {
                    open({ kind: h.mode === 'l2' ? M.KINDS.l2 : M.KINDS.bgp, namespace: h.adv.obj.metadata.namespace, name: h.adv.name });
                }),
                h.mode,
            );
            arrow();
            var nodes = h.known ? h.nodes : h.candidates;
            if (nodes.length === 0) {
                hop('node', 'no node', null, 'error');
            } else if (h.known || nodes.length === 1) {
                var names = el('span');
                nodes.slice(0, 3).forEach(function (n, i) {
                    if (i > 0) names.appendChild(document.createTextNode(', '));
                    names.appendChild(
                        K.link(n.name, function () {
                            open({ kind: M.KINDS.nodes, namespace: '', name: n.name });
                        }),
                    );
                    if (n.interfaces && n.interfaces.length) names.appendChild(el('span', 'faint', ' ' + n.interfaces.join(',')));
                });
                hop('node', h.mode === 'l2' ? 'answered by' : 'from', names);
            } else {
                hop('node', (h.mode === 'l2' ? 'one of ' : '') + nodes.length + ' nodes', null);
            }
            if (h.mode === 'bgp' && h.peers.length) {
                arrow();
                hop(
                    'peer',
                    'to',
                    el(
                        'span',
                        '',
                        h.peers
                            .map(function (p) {
                                return p.name;
                            })
                            .join(', '),
                    ),
                );
            }
        });
        return strip;
    }

    function controls(model, svc) {
        var box = el('div', 'svc-controls');

        var poolRow = el('div', 'control');
        var picker = K.poolPicker(model, svc.requestedPool, svc);
        add(
            poolRow,
            el('span', 'control-label', 'Pool'),
            picker,
            K.button('Apply', 'small', null, function () {
                apply(svc, K.patches.movePool(model, svc, picker.value), 'Asked MetalLB to serve ' + svc.name + ' from ' + (picker.value || 'any pool') + '.');
            }),
        );
        box.appendChild(poolRow);

        if (svc.ips.length) {
            var pinned = svc.requestedIPs.length > 0;
            var pinRow = el('div', 'control');
            add(
                pinRow,
                el('span', 'control-label', 'Address'),
                el('span', 'control-value', pinned ? 'pinned to ' + svc.requestedIPs.join(', ') : 'assigned by MetalLB'),
                K.button(pinned ? 'Unpin' : 'Pin it', 'small', 'pin', function () {
                    if (pinned) apply(svc, K.patches.unpin(model, svc), 'Unpinned ' + svc.name + '.');
                    else apply(svc, K.patches.pin(model, svc), 'Pinned ' + svc.ips.join(', ') + ' for ' + svc.name + '.');
                }),
            );
            box.appendChild(pinRow);
        }
        return box;
    }

    function drawLoadBalancer(model, svc) {
        var root = $('root');
        root.textContent = '';

        var head = el('div', 'svc-head');
        var waiting = svc.ips.length === 0 && svc.hostnames.length === 0;
        head.appendChild(waiting ? K.chip('waiting for an address', 'warn', 'alert') : K.chip('address assigned', 'ok', 'check'));
        if (svc.shareKey) head.appendChild(K.chip('shares key ' + svc.shareKey, 'muted', 'share'));
        if (svc.localTraffic) head.appendChild(K.chip('externalTrafficPolicy: Local', 'muted', 'info', 'Only nodes with a ready pod of this service announce it'));
        var aside = el('span', 'faint small push', model.version ? 'MetalLB ' + model.version : '');
        head.appendChild(aside);
        root.appendChild(head);

        if (waiting) {
            var d = svc.diagnosis || M.diagnose(svc, model);
            var why = el('div', 'why ' + d.tone);
            add(why, K.icon('alert'), el('span', '', d.text));
            root.appendChild(why);
        }

        svc.ips.forEach(function (text) {
            var ip = M.parseIP(text);
            var at = ip ? model.allocations.get(M.ipKey(ip)) : null;
            var block = el('div', 'svc-ip');
            var big = el('code', 'big-ip', text);
            big.title = 'Select to copy';
            block.appendChild(big);
            if (at) {
                block.appendChild(hopStrip(model, svc, at.pool));
            } else {
                block.appendChild(el('div', 'faint small', 'Not from any MetalLB pool — another load balancer, or a pool since removed.'));
            }
            root.appendChild(block);
        });
        svc.hostnames.forEach(function (name) {
            var block = el('div', 'svc-ip');
            add(block, el('code', 'big-ip', name), el('div', 'faint small', 'A hostname, so this address came from a cloud load balancer rather than MetalLB.'));
            root.appendChild(block);
        });

        if (state.ctx.write && model.pools.length) root.appendChild(controls(model, svc));
    }

    // ----- polling -----------------------------------------------------------

    function tick() {
        sdk.object()
            .then(function (obj) {
                if (M.dig(obj, 'spec.type') !== 'LoadBalancer') {
                    var sig = 'plain@' + obj.metadata.resourceVersion + '@' + state.installed;
                    if (sig !== state.sig && !held()) {
                        state.sig = sig;
                        drawPlain(obj);
                    }
                    return null;
                }
                return M.load(sdk).then(function (model) {
                    state.installed = model.installed;
                    var svc = model.services.find(function (s) {
                        return s.key === obj.metadata.namespace + '/' + obj.metadata.name;
                    });
                    if (!svc) return;
                    if (!svc.diagnosis) svc.diagnosis = M.diagnose(svc, model);
                    var sig = model.sig;
                    if (sig !== state.sig && !held()) {
                        state.sig = sig;
                        drawLoadBalancer(model, svc);
                    }
                });
            })
            .then(function () {
                $('error').hidden = true;
            })
            .catch(fail)
            .then(function () {
                setTimeout(tick, POLL);
            });
    }

    sdk.ready()
        .then(function (context) {
            state.ctx = context;
            if (!context.object) {
                fail(new Error('This page is a panel, drawn for one Service.'));
                return;
            }
            // Asked once: whether a not-LoadBalancer service is worth offering
            // to convert at all.
            sdk.list({ kind: M.KINDS.pools, namespace: '' }).then(
                function () {
                    state.installed = true;
                },
                function () {
                    state.installed = false;
                },
            )
                .then(tick);
        })
        .catch(fail);
})();
