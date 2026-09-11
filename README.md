# MetalLB for K8s Dockside

A plugin for the [K8s Dockside](https://github.com/rogerwesterbo/k8sdockside)
desktop app that shows [MetalLB](https://metallb.io/) as what it manages:
addresses.

It answers the questions you have when a LoadBalancer service has no address, or
has one nobody can reach: which pool it came from, how full each pool is, which
node answers for it or which routers it is announced to, and what is wrong with
the path in between. In plain words, not as rows of custom resources.

Plain HTML and script, no build step: the repository is the plugin.

Needs **K8s Dockside 0.0.15 or newer** and MetalLB in the cluster. Prometheus is
optional, for the charts.

## What it shows

**Overview**, which replaces the app's generated overview page:

- A verdict ("Every LoadBalancer has an address", "2 services are waiting for
  an address") and a sentence on how the addresses are being used.
- The addresses in use as a ring, one slice per pool.
- The path from pool to network as stages (pools, advertisements, speakers,
  peers) that turn red where it breaks.
- MetalLB's recent events and its charts, when the cluster has a Prometheus.
- When the cluster has no MetalLB, or cannot be reached, it says which.

**Address space** is the working page:

- Every IPAddressPool as a seat map of its addresses, coloured by the namespace
  holding each one.
- Click an address to follow its route out of the cluster: service → pool →
  advertisement → the node answering ARP/NDP (Layer 2), or the BGP peers it is
  announced to.
- Click a free address to give it to a service.
- LoadBalancer services still waiting for an address are listed first, with the
  reason and a pool to fix it.

**Announcements** draws pools → advertisements → nodes → BGP peers as a flow you
can hover to trace, with what is wrong with the setup underneath.

**Panels in detail views**

- **Service**: the address it got, the pool it came from, how it is announced,
  and controls to move it to another pool or to pin or unpin its address.
  Services that are not LoadBalancers can be made one.
- **IPAddressPool**: the pool's addresses and who holds them, with switches for
  *auto-assign* and *avoid buggy IPs*.

**Tables** for pools, L2 and BGP advertisements, BGP peers, BFD profiles,
communities, the Layer 2 and BGP status objects (MetalLB 0.14+), and MetalLB's
own pods.

## Installing

In K8s Dockside, **Settings → Plugins**. MetalLB is in the list of known plugins
with an **Install** button, and the sidebar suggests it for any cluster that
runs MetalLB. You can also use **From a repository** with this address:

```
https://github.com/rogerwesterbo/k8sdockside-metallb.git
```

The app clones it into its plugins folder, and the plugin's card gets an
**Update from repository** button.

To work on it, clone it anywhere and add the folder that *contains* it with
**Settings → Plugins → Watch another folder**. Press **Reload** after changing
`plugin.json`; files under `ui/` are read fresh whenever a view is opened.

## What it reads, and what it may change

The pages read, through the app's bridge and only in the cluster of the tab they
are in:

- MetalLB's own kinds (`metallb.io`): pools, advertisements, peers, BFD
  profiles, communities and the status objects
- Services, Nodes, Pods (MetalLB's speakers and controller) and Events

It never reads Secrets, such as BGP passwords. The app would refuse them.

The only changes it can ask for:

- on a **Service**: MetalLB's `address-pool` and `loadBalancerIPs` annotations
  (under `metallb.io/`, or `metallb.universe.tf/` on clusters still using the
  old prefix), clearing the deprecated `spec.loadBalancerIP` when they are set,
  and `spec.type: LoadBalancer`
- on an **IPAddressPool**: `spec.autoAssign` and `spec.avoidBuggyIPs`

The app shows you every change before it is made, and applies it only when you
say so.

## Checking it

The app checks the plugin when it loads it. To run the same checks without the
app, for example in CI:

```
go run github.com/rogerwesterbo/k8sdockside/cmd/plugincheck@main .
```

`.github/workflows/check.yml` does this on every push.

## Layout

```
plugin.json      the manifest: kinds, views, cards, charts, panels, links
ui/
├── model.js     reads everything once per poll and works it out
├── kit.js       shared drawing: seat maps, routes, patches, icons
├── metallb.css  one stylesheet, on the app's theme tokens
├── overview.html  the overview           → overview.js
├── index.html     Address space          → space.js
├── routes.html    Announcements          → routes.js
├── service.html   the Service panel      → service.js
└── pool.html      the IPAddressPool panel → pool.js
```

See the app's [plugin documentation](https://github.com/rogerwesterbo/k8sdockside/blob/main/docs/plugins.md)
for the format.
