--[[
	«Synkroniser med Foto»: henter det som er laget eller endret på nettstedet inn i Lightroom.
	Startes fra Fil (eller Bibliotek) → Ekstra pluginmoduler → Synkroniser med Foto … (FotoSyncMenu.lua).

	- Mapper og album som er laget på nettstedet, blir mapper og album under Foto-tjenesten, koblet til
	  dem på nettstedet. Det du publiserer i dem senere, havner på samme sted.
	- Bilder som er lastet opp på nettstedet, kobles til samme bilde i katalogen når det finnes der
	  (samme filnavn og opptakstid). Ellers kan originalen lastes ned og importeres.
	- Navn, plassering og synlighet som er endret på nettstedet, oppdateres i Lightroom.
	- Det som er slettet på nettstedet, kan fjernes fra Lightroom (valgfritt, av som standard).

	Bildene på nettstedet endres aldri herfra. Det du gjør i Lightroom, sendes som før med «Publiser».
	Først sendes innstillinger som ble endret i Lightroom uten nett (de vinner over nettstedet).

	Lightroom-regler: katalogen endres bare inni withWriteAccessDo, aldri med nettkall der inne, og
	nye samlinger kan ikke leses (navn, localIdentifier) i samme skrivelås som de ble laget i.
]]

local LrApplication = import 'LrApplication'
local LrBinding = import 'LrBinding'
local LrDialogs = import 'LrDialogs'
local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrPrefs = import 'LrPrefs'
local LrProgressScope = import 'LrProgressScope'
local LrTasks = import 'LrTasks'
local LrView = import 'LrView'

local Common = require 'FotoCommon'
local FotoAPI = require 'FotoAPI'
local Log = require 'FotoLog'

local Sync = {}

local IMPORT_BATCH = 100
local GATE_TIMEOUT = 30
-- Filtyper Lightroom kan importere (det nettstedet tar imot: JPEG, PNG, TIFF, WebP, AVIF).
local IMPORTABLE = { jpg = true, jpeg = true, png = true, tif = true, tiff = true, webp = true, avif = true, heic = true, heif = true, psd = true, dng = true }

-- Små hjelpere -------------------------------------------------------------------

local function plural(n, one, many)
	return tostring(n) .. ' ' .. (n == 1 and one or many)
end

local function lower(s)
	return string.lower(tostring(s or ''))
end

--- «a, b og c», med «… og n til» når lista er lang.
local function listText(names, max)
	max = max or 4
	local shown = {}
	for i = 1, math.min(#names, max) do shown[i] = '«' .. names[i] .. '»' end
	local rest = #names - #shown
	if rest > 0 then return table.concat(shown, ', ') .. ' og ' .. rest .. ' til' end
	if #shown <= 1 then return shown[1] or '' end
	return table.concat(shown, ', ', 1, #shown - 1) .. ' og ' .. shown[#shown]
end

--- «a, b og c» uten anførselstegn.
local function joinAnd(parts)
	if #parts <= 1 then return parts[1] or '' end
	return table.concat(parts, ', ', 1, #parts - 1) .. ' og ' .. parts[#parts]
end

local function sizeText(bytes)
	bytes = tonumber(bytes) or 0
	local function comma(s) return (s:gsub('%.', ',')) end
	if bytes >= 1024 ^ 3 then return comma(string.format('%.1f GB', bytes / 1024 ^ 3)) end
	if bytes >= 1024 ^ 2 then return string.format('%d MB', math.floor(bytes / 1024 ^ 2 + 0.5)) end
	return 'under 1 MB'
end

--- Opptakstid som veggklokke, «2026-10-07T14:30:00» (uten brøkdeler og tidssone), eller nil.
function Sync.wallOf(iso)
	if type(iso) ~= 'string' then return nil end
	return iso:match('^(%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d)')
end

--- Filnavn uten mappe og filendelse, med små bokstaver: «ED1_0590.NEF» → «ed1_0590».
function Sync.stemOf(name)
	local leaf = lower(name):match('([^/\\]+)$') or lower(name)
	return (leaf:gsub('%.[^%.]*$', ''))
end

local function extensionOf(name)
	return lower(tostring(name or ''):match('%.([^%./\\]+)$') or '')
end

--- Trygt navn på en mappe eller fil på disken (macOS og Windows).
function Sync.safeName(s)
	s = tostring(s or ''):gsub('[%c/\\:%*%?"<>|]', '-'):gsub('^[%s%.]+', ''):gsub('[%s%.]+$', '')
	if #s > 100 then
		-- Ikke kutt midt i en æ/ø/å (UTF-8): fjern et påbegynt tegn til slutt.
		s = s:sub(1, 100):gsub('[\192-\255][\128-\191]*$', '')
	end
	if s == '' then s = 'uten-navn' end
	return s
end

local function gate(catalog, title, fn)
	local status = catalog:withWriteAccessDo(title, fn, { timeout = GATE_TIMEOUT })
	if status == 'aborted' then
		error('Katalogen var opptatt med noe annet. Vent litt og prøv igjen.', 0)
	end
end

-- Lightroom: les mappene og albumene under tjenesten ------------------------------

local function readLightroom(service)
	local lr = { entries = {}, byLrId = { folder = {}, album = {} }, byRemoteId = {}, root = { children = {}, isRoot = true } }
	local function add(e, parent)
		e.parent = parent
		parent.children[#parent.children + 1] = e
		lr.entries[#lr.entries + 1] = e
		lr.byLrId[e.kind][e.lrId] = e
		if e.remoteId and not lr.byRemoteId[e.remoteId] then lr.byRemoteId[e.remoteId] = e end
	end
	local function base(obj, kind)
		local okUrl, url = LrTasks.pcall(function() return obj:getRemoteUrl() end)
		return {
			obj = obj,
			kind = kind,
			lrId = tostring(obj.localIdentifier),
			name = obj:getName(),
			children = {},
			remoteId = Common.remoteIdOf(obj),
			remoteUrl = okUrl and url or nil,
			settings = Common.settingsOf(obj),
		}
	end
	local function walk(container, parent)
		for _, set in ipairs(container:getChildCollectionSets() or {}) do
			local e = base(set, 'folder')
			add(e, parent)
			walk(set, e)
		end
		for _, c in ipairs(container:getChildCollections() or {}) do
			local e = base(c, 'album')
			e.smart = c:isSmartCollection() == true
			e.published, e.publishedByPhoto, e.members = {}, {}, {}
			for _, pp in ipairs(c:getPublishedPhotos() or {}) do
				local rid = pp:getRemoteId()
				local photo = pp:getPhoto()
				if rid ~= nil and rid ~= '' and photo then
					rid = tostring(rid)
					e.published[rid] = photo
					e.publishedByPhoto[photo.localIdentifier] = rid
				end
			end
			for _, p in ipairs(c:getPhotos() or {}) do e.members[p.localIdentifier] = p end
			add(e, parent)
		end
	end
	walk(service, lr.root)
	return lr
end

--- Ligger container (eller en mappe over den) i e? Brukes for å unngå å flytte en mappe inn i seg selv.
local function isWithin(container, e, parentOf)
	local guard = 0
	local cur = container
	while cur and guard < 200 do
		if cur == e then return true end
		cur = parentOf(cur)
		guard = guard + 1
	end
	return false
end

-- Plan: hva som skal skje i Lightroom ---------------------------------------------

--[[
	targets[node.id] = { entry = <eksisterende i Lightroom> } eller { create = <lages nå> }.
	Containere (der noe ligger): lr.root, en entry (mappe) eller en create (ny mappe).
]]
function Sync.buildPlan(nodes, lr, serviceKey)
	local plan = {
		creates = {}, links = {}, renames = {}, moves = {}, settings = {}, fixes = {},
		albums = {}, deletedAlbums = {}, deletedSets = {}, skipped = {}, other = 0,
		targets = {}, byId = {},
	}
	local byId, targets, claimed = plan.byId, plan.targets, {}
	local linkedLrIds = { folder = {}, album = {} }
	for _, n in ipairs(nodes) do
		byId[n.id] = n
		if type(n.link) == 'table' and n.link.lrId ~= nil then linkedLrIds[n.type][tostring(n.link.lrId)] = true end
	end

	local function claim(n, e, link)
		targets[n.id] = { entry = e }
		claimed[e] = true
		if link then plan.links[#plan.links + 1] = { node = n, entry = e, relink = link == 'relink' } end
	end
	local function create(n, parent, relink)
		local c = { node = n, kind = n.type, parent = parent, relink = relink, children = {} }
		-- Containeren den lages i: rota, en mappe som finnes, eller en mappe som lages nå.
		c.container = parent == nil and lr.root or (parent.entry or parent.create)
		plan.creates[#plan.creates + 1] = c
		targets[n.id] = { create = c }
	end
	--- Ledig samling/mappe med samme navn og type: aldri publisert og ikke koblet til noe på nettstedet.
	local function freeTwin(container, n)
		for _, e in ipairs(container.children or {}) do
			if e.kind == n.type and lower(e.name) == lower(n.name) and not claimed[e] and not e.remoteId
				and not linkedLrIds[e.kind][e.lrId] and not e.smart then
				return e
			end
		end
		return nil
	end

	for _, n in ipairs(nodes) do
		local parentTarget = n.parentId and targets[n.parentId] or nil
		local parentKnown = n.parentId == nil or parentTarget ~= nil
		if type(n.link) == 'table' then
			local e = lr.byLrId[n.type][tostring(n.link.lrId)]
			if e and not claimed[e] then
				claim(n, e)
			else
				local twin = lr.byRemoteId[n.id]
				if twin and twin.kind == n.type and not claimed[twin] then
					claim(n, twin, 'relink')
				elseif parentKnown then
					-- Koblet til en samling som ikke finnes i denne katalogen lenger: lag den på nytt.
					create(n, parentTarget, true)
				else
					plan.skipped[#plan.skipped + 1] = n
				end
			end
		elseif n.link == 'other' then
			plan.other = plan.other + 1
		else
			local twin = lr.byRemoteId[n.id]
			if twin and twin.kind == n.type and not claimed[twin] then
				claim(n, twin, 'link')
			elseif parentKnown then
				local container = parentTarget == nil and lr.root or parentTarget.entry
				local same = container and freeTwin(container, n)
				if same then
					claim(n, same, 'link')
					targets[n.id].merged = true
				else
					create(n, parentTarget, false)
				end
			else
				plan.skipped[#plan.skipped + 1] = n
			end
		end
	end

	-- Endringer på nettstedet for det som finnes i Lightroom fra før.
	local wanted = {}
	for _, n in ipairs(nodes) do
		local t = targets[n.id]
		local e = t and t.entry
		if e then
			if e.name ~= n.name then plan.renames[#plan.renames + 1] = { entry = e, node = n } end
			-- Plassering: bare når mappa over er kjent (finnes eller lages nå).
			if n.parentId == nil or targets[n.parentId] then
				local dest = n.parentId and targets[n.parentId] or nil
				local container = dest and (dest.entry or dest.create) or lr.root
				if container ~= e.parent then wanted[#wanted + 1] = { entry = e, node = n, dest = dest, container = container } end
			end
			if not Common.Pending.has(serviceKey, e.kind, e.lrId) then
				local vis = Common.visibilityOf(e.settings)
				local dl = e.settings.allowDownload == true
				if n.visibility ~= vis or (e.kind == 'album' and (n.allowDownload == true) ~= dl) then
					plan.settings[#plan.settings + 1] = { entry = e, node = n }
				end
			end
			if e.remoteId ~= n.id or e.remoteUrl ~= n.url then plan.fixes[#plan.fixes + 1] = { entry = e, node = n } end
		end
	end

	-- Flyttinger til mapper som finnes, utføres før de nye mappene lages; flyttinger inn i nye mapper etterpå.
	-- Simuler i den rekkefølgen og hopp over det som ville lagt en mappe inni seg selv.
	local simParent = {}
	local function parentOf(x)
		if simParent[x] ~= nil then return simParent[x] end
		if x.container then return x.container end -- ny mappe
		return x.parent
	end
	local ordered = {}
	for _, m in ipairs(wanted) do if not (m.dest and m.dest.create) then ordered[#ordered + 1] = m end end
	for _, m in ipairs(wanted) do if m.dest and m.dest.create then ordered[#ordered + 1] = m end end
	for _, m in ipairs(ordered) do
		if m.container ~= lr.root and isWithin(m.container, m.entry, parentOf) then
			plan.skipped[#plan.skipped + 1] = m.node
		else
			plan.moves[#plan.moves + 1] = m
			simParent[m.entry] = m.container
		end
	end

	-- Bilder i albumene.
	for _, n in ipairs(nodes) do
		local t = targets[n.id]
		if n.type == 'album' and t then
			local ids = n.photoIds or {}
			local onServer = {}
			for _, id in ipairs(ids) do onServer[id] = true end
			-- stale: bilder i Lightroom som er publisert med en ID som ikke finnes på nettstedet lenger.
			local item = { node = n, target = t, unknown = {}, removed = {}, stale = {} }
			local known = t.entry and t.entry.published or {}
			for _, id in ipairs(ids) do
				if not known[id] then item.unknown[#item.unknown + 1] = id end
			end
			if t.entry then
				for rid, photo in pairs(known) do
					if not onServer[rid] then
						item.removed[#item.removed + 1] = photo
						item.stale[photo.localIdentifier] = true
					end
				end
			end
			if #item.unknown > 0 or #item.removed > 0 then plan.albums[#plan.albums + 1] = item end
		end
	end

	-- Slettet på nettstedet: samlinger med vår ID som ikke finnes der lenger.
	local function deletedOnWeb(e)
		return e.remoteId ~= nil and not claimed[e] and byId[e.remoteId] == nil and not linkedLrIds[e.kind][e.lrId]
	end
	local function allDeleted(e)
		if not deletedOnWeb(e) then return false end
		for _, c in ipairs(e.children) do
			if not allDeleted(c) then return false end
		end
		return true
	end
	for _, e in ipairs(lr.entries) do
		if e.kind == 'album' and deletedOnWeb(e) then
			plan.deletedAlbums[#plan.deletedAlbums + 1] = e
		elseif e.kind == 'folder' and allDeleted(e) and not (e.parent and not e.parent.isRoot and allDeleted(e.parent)) then
			plan.deletedSets[#plan.deletedSets + 1] = e
		end
	end
	return plan
end

-- Bildene: koble til katalogen eller last ned ------------------------------------

local function catalogIndex(catalog)
	local photos = catalog:getAllPhotos() or {}
	local raw = catalog:batchGetRawMetadata(photos, { 'path', 'dateTimeOriginalISO8601', 'isVirtualCopy' }) or {}
	local index = {}
	for _, p in ipairs(photos) do
		local m = raw[p] or {}
		if type(m.path) == 'string' then
			local leaf = LrPathUtils.leafName(m.path) or m.path
			local stem = Sync.stemOf(leaf)
			index[stem] = index[stem] or {}
			table.insert(index[stem], {
				photo = p,
				leaf = lower(leaf),
				wall = Sync.wallOf(m.dateTimeOriginalISO8601),
				virtual = m.isVirtualCopy == true,
			})
		end
	end
	return index
end

--- Samme bilde i katalogen: samme filnavn (uten filendelse) og samme opptakstid.
--- Uten opptakstid på nettstedet må hele filnavnet være likt.
--- stale: bilder som er publisert i albumet med en ID som er slettet på nettstedet (kan kobles på nytt,
--- f.eks. når samme bilde er lastet opp igjen).
function Sync.match(index, info, entry, used, stale)
	local list = index[Sync.stemOf(info.filename)]
	if not list then return nil end
	local wall = Sync.wallOf(info.takenAt)
	local best, bestScore
	for _, c in ipairs(list) do
		local same
		if wall then same = c.wall == wall else same = c.leaf == lower(info.filename) end
		local id = c.photo.localIdentifier
		-- Et bilde som allerede er publisert i albumet som et annet bilde, kobles ikke på nytt.
		if same and not used[id] and not (entry and entry.publishedByPhoto[id] and not (stale and stale[id])) then
			local score = (c.virtual and 0 or 2) + ((entry and entry.members[id]) and 1 or 0)
			if not best or score > bestScore then best, bestScore = c.photo, score end
		end
	end
	return best
end

local function folderPathOf(byId, node)
	local parts = {}
	local cur = node
	local guard = 0
	while cur and guard < 50 do
		table.insert(parts, 1, Sync.safeName(cur.name))
		cur = cur.parentId and byId[cur.parentId] or nil
		guard = guard + 1
	end
	return parts
end

-- Dialoger ----------------------------------------------------------------------

local function chooseService(context, services)
	if #services == 1 then return services[1] end
	local f = LrView.osFactory()
	local props = LrBinding.makePropertyTable(context)
	props.service = 1
	local items = {}
	for i, s in ipairs(services) do items[#items + 1] = { title = s:getName(), value = i } end
	local result = LrDialogs.presentModalDialog {
		title = 'Synkroniser med Foto',
		contents = f:column {
			bind_to_object = props,
			spacing = f:control_spacing(),
			f:static_text { title = 'Hvilken Foto-tjeneste vil du synkronisere?' },
			f:popup_menu { value = LrView.bind 'service', items = items },
		},
		actionVerb = 'Fortsett',
		cancelVerb = 'Avbryt',
	}
	if result ~= 'ok' then return nil end
	return services[props.service]
end

--- Linjer som beskriver planen (brukes både før og etter).
local function summaryLines(plan, stats)
	local lines = {}
	local folders, albums = {}, {}
	for _, c in ipairs(plan.creates) do
		if c.kind == 'folder' then folders[#folders + 1] = c.node.name else albums[#albums + 1] = c.node.name end
	end
	local merged = {}
	for _, l in ipairs(plan.links) do
		if plan.targets[l.node.id] and plan.targets[l.node.id].merged then merged[#merged + 1] = l.node.name end
	end
	if #folders + #albums > 0 then
		local parts = {}
		if #folders > 0 then parts[#parts + 1] = plural(#folders, 'mappe', 'mapper') end
		if #albums > 0 then parts[#parts + 1] = plural(#albums, 'album', 'album') end
		local names = {}
		for _, x in ipairs(folders) do names[#names + 1] = x end
		for _, x in ipairs(albums) do names[#names + 1] = x end
		lines[#lines + 1] = 'Nytt fra nettstedet: ' .. table.concat(parts, ' og ') .. ' – ' .. listText(names) .. '.'
	end
	if #merged > 0 then
		lines[#lines + 1] = 'Kobles til ' .. (#merged == 1 and 'den' or 'de') .. ' med samme navn i Lightroom: ' .. listText(merged) .. '.'
	end
	local changed = {}
	if #plan.renames > 0 then changed[#changed + 1] = plural(#plan.renames, 'nytt navn', 'nye navn') end
	if #plan.moves > 0 then changed[#changed + 1] = plural(#plan.moves, 'flyttet', 'flyttet') end
	if #plan.settings > 0 then changed[#changed + 1] = plural(#plan.settings, 'ny synlighet eller nedlasting', 'nye synligheter eller nedlastinger') end
	if #changed > 0 then lines[#lines + 1] = 'Endret på nettstedet: ' .. joinAnd(changed) .. '.' end
	if stats.matched > 0 then
		lines[#lines + 1] = plural(stats.matched, 'nytt bilde', 'nye bilder') .. ' på nettstedet finnes i katalogen og kobles til '
			.. (stats.matched == 1 and 'det' or 'dem') .. '.'
	end
	if stats.smartSkipped > 0 then
		lines[#lines + 1] = plural(stats.smartSkipped, 'bilde', 'bilder') .. ' ligger i smarte album og kan ikke legges inn fra nettstedet.'
	end
	if plan.other > 0 then
		lines[#lines + 1] = plural(plan.other, 'mappe eller album', 'mapper og album') .. ' hører til en annen Lightroom-katalog og røres ikke.'
	end
	if #plan.skipped > 0 then
		local names = {}
		for _, n in ipairs(plan.skipped) do names[#names + 1] = n.name end
		lines[#lines + 1] = 'Hoppes over: ' .. listText(names) .. ' (ligger i en mappe som ikke kan hentes, eller kan ikke flyttes).'
	end
	return lines
end

local function removalText(stats)
	local parts = {}
	if stats.deletedAlbums > 0 then parts[#parts + 1] = plural(stats.deletedAlbums, 'album', 'album') end
	if stats.deletedSets > 0 then parts[#parts + 1] = plural(stats.deletedSets, 'mappe', 'mapper') end
	if stats.removedPhotos > 0 then parts[#parts + 1] = plural(stats.removedPhotos, 'bilde', 'bilder') end
	return joinAnd(parts)
end

local function confirm(context, service, plan, stats, prefs)
	local f = LrView.osFactory()
	local bind = LrView.bind
	local props = LrBinding.makePropertyTable(context)
	props.download = prefs.syncDownload ~= false
	props.folder = prefs.syncFolder
	props.remove = false

	local rows = {
		bind_to_object = props,
		spacing = f:control_spacing(),
		fill_horizontal = 1,
		f:static_text {
			title = 'Dette hentes fra nettstedet til «' .. service:getName() .. '»:',
			fill_horizontal = 1,
		},
	}
	for _, line in ipairs(summaryLines(plan, stats)) do
		rows[#rows + 1] = f:static_text {
			title = '•  ' .. line,
			fill_horizontal = 1,
			width_in_chars = 64,
			height_in_lines = math.max(1, math.ceil(#line / 64)),
		}
	end
	if stats.downloads > 0 then
		rows[#rows + 1] = f:checkbox {
			title = 'Last ned og importer ' .. plural(stats.downloads, 'bilde', 'bilder') .. ' som bare finnes på nettstedet ('
				.. sizeText(stats.downloadBytes) .. ')',
			value = bind 'download',
		}
		rows[#rows + 1] = f:row {
			f:spacer { width = 18 },
			f:static_text { title = 'Til:' },
			f:edit_field { value = bind 'folder', width_in_chars = 38, enabled = bind 'download' },
			f:push_button {
				title = 'Velg …',
				enabled = bind 'download',
				action = function()
					local chosen = LrDialogs.runOpenPanel {
						title = 'Hvor skal bildene fra nettstedet lagres?',
						canChooseFiles = false,
						canChooseDirectories = true,
						canCreateDirectories = true,
						allowsMultipleSelection = false,
						initialDirectory = props.folder,
					}
					if type(chosen) == 'table' and chosen[1] then props.folder = chosen[1] end
				end,
			},
		}
	end
	if stats.deletedAlbums + stats.deletedSets + stats.removedPhotos > 0 then
		rows[#rows + 1] = f:checkbox {
			title = 'Fjern fra Lightroom det som er slettet på nettstedet (' .. removalText(stats) .. ')',
			value = bind 'remove',
		}
	end
	rows[#rows + 1] = f:static_text {
		title = 'Bildene på nettstedet endres ikke. Det du legger til i albumene i Lightroom, lastes opp når du trykker «Publiser».',
		fill_horizontal = 1,
		width_in_chars = 64,
		height_in_lines = 2,
	}
	local result = LrDialogs.presentModalDialog {
		title = 'Synkroniser med Foto',
		contents = f:column(rows),
		actionVerb = 'Synkroniser',
		cancelVerb = 'Avbryt',
	}
	if result ~= 'ok' then return nil end
	local folder = tostring(props.folder or ''):gsub('^%s+', ''):gsub('%s+$', '')
	if props.download and stats.downloads > 0 then
		if folder == '' then error('Velg en mappe for bildene som skal lastes ned.', 0) end
		prefs.syncFolder = folder
	end
	if stats.downloads > 0 then prefs.syncDownload = props.download == true end
	return { download = props.download == true and stats.downloads > 0, folder = folder, remove = props.remove == true }
end

-- Selve synkroniseringen ----------------------------------------------------------

--- Sender innstillinger som ble endret i Lightroom uten nett (de vinner over nettstedet).
local function pushPending(api, lr, serviceKey, problems)
	for _, e in ipairs(lr.entries) do
		if Common.Pending.has(serviceKey, e.kind, e.lrId) then
			local ok, err = LrTasks.pcall(function()
				local payload = {
					serviceKey = serviceKey,
					kind = e.kind,
					lrId = e.lrId,
					name = e.name,
					parents = Common.ancestry(e.obj),
					visibility = Common.visibilityOf(e.settings),
					applySettings = true,
					remoteId = e.remoteId,
				}
				if e.kind == 'album' then payload.allowDownload = e.settings.allowDownload == true end
				api:sync(payload)
			end)
			if ok then
				Common.Pending.clear(serviceKey, e.kind, e.lrId)
				Log.info('Synkroniser: sendte ventende innstillinger for', e.kind, e.name)
			else
				problems[#problems + 1] = '«' .. e.name .. '»: innstillingene fra Lightroom kom ikke fram (' .. FotoAPI.messageOf(err) .. ').'
			end
		end
	end
end

function Sync.run(context)
	LrDialogs.attachErrorDialogToFunctionContext(context)
	local catalog = LrApplication.activeCatalog()
	local prefs = LrPrefs.prefsForPlugin()
	if not prefs.syncFolder or prefs.syncFolder == '' then
		prefs.syncFolder = LrPathUtils.child(LrPathUtils.getStandardFilePath('pictures'), 'Foto')
	end

	local services = catalog:getPublishServices(_PLUGIN.id) or {}
	if #services == 0 then
		LrDialogs.message(
			'Lag Foto-tjenesten først',
			'Klikk + i panelet «Publiser tjenester» → «Gå til Administrasjon av publisering …», velg Foto, '
				.. 'trykk «Koble til Foto …» og lagre. Kjør så synkroniseringen igjen.',
			'info'
		)
		return
	end
	local service = chooseService(context, services)
	if not service then return end

	local settings = service:getPublishSettings() or {}
	local okApi, api = LrTasks.pcall(function() return FotoAPI.new(settings) end)
	if not okApi then
		LrDialogs.message('Koble til Foto først', FotoAPI.messageOf(api), 'info')
		return
	end
	-- Nøkkelen er det som skiller albumene fra denne tjenesten fra andre. Uten den kunne vi koblet
	-- albumene på nettstedet til feil nøkkel, og neste publisering ville laget kopier.
	if type(settings.serviceKey) ~= 'string' or settings.serviceKey == '' then
		LrDialogs.message(
			'Lagre Foto-innstillingene én gang først',
			'Høyreklikk Foto under «Publiser tjenester», velg «Rediger innstillinger …» og trykk «Lagre». '
				.. 'Kjør så synkroniseringen igjen.',
			'info'
		)
		return
	end
	local serviceKey = Common.serviceKeyOf(settings, service)
	local progress = LrProgressScope { title = 'Synkroniserer med Foto', functionContext = context }
	local problems = {}

	progress:setCaption('Sammenligner med nettstedet …')
	local lr = readLightroom(service)
	pushPending(api, lr, serviceKey, problems)
	local nodes = api:lrTree(serviceKey)
	local plan = Sync.buildPlan(nodes, lr, serviceKey)
	Log.info('Synkroniser:', #nodes, 'på nettstedet,', #lr.entries, 'i Lightroom,', #plan.creates, 'nye,', #plan.links, 'koblinger,',
		#plan.renames, 'navn,', #plan.moves, 'flyttinger,', #plan.settings, 'innstillinger,', #plan.albums, 'album med endrede bilder')

	-- Bildene som er nye på nettstedet: koble til katalogen eller last ned.
	local stats = { matched = 0, downloads = 0, downloadBytes = 0, smartSkipped = 0, deletedAlbums = #plan.deletedAlbums,
		deletedSets = #plan.deletedSets, removedPhotos = 0 }
	local index
	for _, item in ipairs(plan.albums) do
		if #item.unknown > 0 then
			local entry = item.target.entry
			local smart = entry and entry.smart
			local infos = {}
			for _, info in ipairs(api:albumPhotos(item.node.id)) do infos[info.id] = info end
			index = index or catalogIndex(catalog)
			local used = {}
			item.links, item.downloads = {}, {}
			for _, id in ipairs(item.unknown) do
				local info = infos[id]
				if info then
					local photo = Sync.match(index, info, entry, used, item.stale)
					if photo and smart and not entry.members[photo.localIdentifier] then photo = nil end
					if photo then
						used[photo.localIdentifier] = true
						item.links[#item.links + 1] = { id = id, info = info, photo = photo }
						stats.matched = stats.matched + 1
						if item.stale[photo.localIdentifier] then
							-- Koblet på nytt: skal ikke fjernes fra albumet.
							item.stale[photo.localIdentifier] = nil
							local keep = {}
							for _, r in ipairs(item.removed) do
								if r.localIdentifier ~= photo.localIdentifier then keep[#keep + 1] = r end
							end
							item.removed = keep
						end
					elseif smart then
						stats.smartSkipped = stats.smartSkipped + 1
					else
						item.downloads[#item.downloads + 1] = { id = id, info = info }
						stats.downloads = stats.downloads + 1
						stats.downloadBytes = stats.downloadBytes + (tonumber(info.bytes) or 0)
					end
				end
			end
		end
	end

	for _, item in ipairs(plan.albums) do stats.removedPhotos = stats.removedPhotos + #item.removed end

	local anything = #plan.creates + #plan.links + #plan.renames + #plan.moves + #plan.settings + stats.matched
		+ stats.downloads + stats.deletedAlbums + stats.deletedSets + stats.removedPhotos > 0
	if not anything then
		-- Bare «stille» rettelser (vår ID og adresse på samlingene i Lightroom).
		if #plan.fixes > 0 then
			gate(catalog, 'Synkroniser med Foto', function()
				for _, x in ipairs(plan.fixes) do
					x.entry.obj:setRemoteId(x.node.id)
					x.entry.obj:setRemoteUrl(x.node.url)
				end
			end)
		end
		progress:done()
		local same = stats.smartSkipped == 0 and #plan.skipped == 0
		local lines = { same and 'Lightroom og nettstedet har de samme mappene, albumene og bildene.' or 'Det er ingenting å hente fra nettstedet.' }
		for _, line in ipairs(summaryLines(plan, stats)) do lines[#lines + 1] = line end
		for _, p in ipairs(problems) do lines[#lines + 1] = p end
		LrDialogs.message(same and 'Alt er likt' or 'Ingenting å hente', table.concat(lines, '\n\n'), 'info')
		Log.info('Synkroniser: alt er likt')
		return
	end

	local opts = confirm(context, service, plan, stats, prefs)
	if not opts then
		progress:done()
		return
	end

	local done = { created = { folder = 0, album = 0 }, renamed = 0, moved = 0, settings = 0, linked = 0, downloaded = 0,
		imported = 0, removedPhotos = 0, deletedAlbums = 0, deletedSets = 0 }
	local function problem(text)
		problems[#problems + 1] = text
		Log.warn('Synkroniser:', text)
	end
	local function containerObj(target)
		if target == nil then return nil, true end
		if target.entry then return target.entry.obj, true end
		if target.create and target.create.obj then return target.create.obj, true end
		return nil, false
	end

	-- 1. Mapper og album (én skrivelås).
	progress:setCaption('Oppdaterer mapper og album …')
	local structure = #plan.renames + #plan.moves + #plan.creates + #plan.settings + #plan.fixes > 0
	local function tryDo(what, fn)
		local ok, err = LrTasks.pcall(fn)
		if not ok then problem(what .. ': ' .. FotoAPI.messageOf(err)) end
		return ok
	end
	if structure then gate(catalog, 'Synkroniser med Foto', function()
		for _, r in ipairs(plan.renames) do
			tryDo('«' .. r.entry.name .. '» kunne ikke få nytt navn', function()
				if r.entry.obj:setName(r.node.name) == false then
					error('det finnes allerede noe som heter «' .. r.node.name .. '» der', 0)
				end
				done.renamed = done.renamed + 1
			end)
		end
		local later = {}
		for _, m in ipairs(plan.moves) do
			if m.dest and m.dest.create then
				later[#later + 1] = m
			else
				tryDo('«' .. m.node.name .. '» kunne ikke flyttes', function()
					m.entry.obj:setParent(m.dest and m.dest.entry.obj or nil)
					done.moved = done.moved + 1
				end)
			end
		end
		for _, c in ipairs(plan.creates) do
			local parentObj, parentOk = containerObj(c.parent)
			if not parentOk then
				problem('«' .. c.node.name .. '» ble ikke laget, fordi mappa over ikke kunne lages.')
			else
				tryDo('«' .. c.node.name .. '» kunne ikke lages', function()
					local obj
					if c.kind == 'folder' then
						obj = service:createPublishedCollectionSet(c.node.name, parentObj, false)
					else
						obj = service:createPublishedCollection(c.node.name, parentObj, false)
					end
					if not obj then error('det finnes allerede en mappe eller et album med samme navn der i Lightroom', 0) end
					obj:setRemoteId(c.node.id)
					obj:setRemoteUrl(c.node.url)
					if c.kind == 'folder' then
						obj:setCollectionSetSettings { visibility = c.node.visibility }
					else
						obj:setCollectionSettings { visibility = c.node.visibility, allowDownload = c.node.allowDownload == true }
					end
					c.obj = obj
					done.created[c.kind] = done.created[c.kind] + 1
				end)
			end
		end
		for _, m in ipairs(later) do
			if m.dest.create.obj then
				tryDo('«' .. m.node.name .. '» kunne ikke flyttes', function()
					m.entry.obj:setParent(m.dest.create.obj)
					done.moved = done.moved + 1
				end)
			end
		end
		for _, s in ipairs(plan.settings) do
			tryDo('Innstillingene for «' .. s.node.name .. '» kunne ikke oppdateres', function()
				local t = {}
				for k, v in pairs(s.entry.settings or {}) do t[k] = v end
				t.visibility = s.node.visibility
				if s.entry.kind == 'album' then
					t.allowDownload = s.node.allowDownload == true
					s.entry.obj:setCollectionSettings(t)
				else
					s.entry.obj:setCollectionSetSettings(t)
				end
				done.settings = done.settings + 1
			end)
		end
		for _, x in ipairs(plan.fixes) do
			LrTasks.pcall(function()
				x.entry.obj:setRemoteId(x.node.id)
				x.entry.obj:setRemoteUrl(x.node.url)
			end)
		end
	end) end

	-- 2. Koble mappene og albumene på nettstedet til samlingene i Lightroom.
	local links, linkNames = {}, {}
	for _, c in ipairs(plan.creates) do
		if c.obj then
			links[#links + 1] = { id = c.node.id, kind = c.kind, lrId = tostring(c.obj.localIdentifier), relink = c.relink or nil }
			linkNames[#links] = c.node.name
		end
	end
	for _, l in ipairs(plan.links) do
		links[#links + 1] = { id = l.node.id, kind = l.node.type, lrId = l.entry.lrId, relink = l.relink or nil }
		linkNames[#links] = l.node.name
	end
	if #links > 0 then
		local okLink, results = LrTasks.pcall(function() return api:link(serviceKey, links) end)
		if not okLink then
			problem('Koblingen til nettstedet ble ikke lagret (' .. FotoAPI.messageOf(results) .. '). Den lagres når du publiserer, eller synkroniserer på nytt.')
		else
			for i, r in ipairs(results) do
				if type(r) == 'table' and r.ok == false then
					problem('«' .. tostring(linkNames[i]) .. '» ble ikke koblet til nettstedet: ' .. tostring(r.error))
				end
			end
		end
	end

	-- 3. Last ned bilder som bare finnes på nettstedet.
	local imports = {}
	if opts.download then
		local total, n, canceled = stats.downloads, 0, false
		local taken = {} -- stier som er brukt i denne kjøringen
		for _, item in ipairs(plan.albums) do
			if canceled then break end
			local albumObj = item.target.entry and item.target.entry.obj or (item.target.create and item.target.create.obj)
			if not albumObj and #(item.downloads or {}) > 0 then
				problem('Bildene i «' .. item.node.name .. '» ble ikke lastet ned, fordi albumet ikke kunne lages i Lightroom.')
			end
			for _, d in ipairs(albumObj and item.downloads or {}) do
				if progress:isCanceled() then
					canceled = true
					problem('Nedlastingen ble avbrutt. Resten hentes neste gang du synkroniserer.')
					break
				end
				n = n + 1
				progress:setCaption('Laster ned ' .. n .. ' av ' .. total .. ' …')
				progress:setPortionComplete(n - 1, total)
				local info = d.info
				local parts = folderPathOf(plan.byId, item.node)
				local dir = opts.folder
				for _, part in ipairs(parts) do dir = LrPathUtils.child(dir, part) end
				local name = Sync.safeName(info.downloadName or info.filename)
				local path = LrPathUtils.child(dir, name)
				local ok, err = LrTasks.pcall(function()
					LrFileUtils.createAllDirectories(dir)
					local stem, ext = name:match('^(.*)(%.[^%.]+)$')
					if taken[path] then path = LrPathUtils.child(dir, (stem or name) .. '-' .. info.id:sub(1, 6) .. (ext or '')) end
					if LrFileUtils.exists(path) and not taken[path] then
						local existing = catalog:findPhotoByPath(path)
						local attrs = LrFileUtils.fileAttributes(path) or {}
						if tonumber(attrs.fileSize) == tonumber(info.bytes) then
							d.path = path
							d.photo = existing
							return
						end
						path = LrPathUtils.child(dir, (stem or name) .. '-' .. info.id:sub(1, 6) .. (ext or ''))
						if LrFileUtils.exists(path) then
							attrs = LrFileUtils.fileAttributes(path) or {}
							if tonumber(attrs.fileSize) == tonumber(info.bytes) then
								d.path = path
								d.photo = catalog:findPhotoByPath(path)
								return
							end
						end
					end
					api:download(info.id, path, info.bytes)
					d.path = path
					done.downloaded = done.downloaded + 1
				end)
				if d.path then taken[d.path] = true end
				if ok then
					if not d.photo then
						if IMPORTABLE[extensionOf(d.path)] then
							imports[#imports + 1] = d
						else
							problem('«' .. name .. '» ble lastet ned, men Lightroom kan ikke importere den filtypen.')
						end
					end
				else
					problem('«' .. name .. '» kunne ikke lastes ned: ' .. FotoAPI.messageOf(err))
				end
			end
		end
		progress:setPortionComplete(1, 1)

		-- 4. Importer dem i katalogen (i bolker, så skrivelåsen ikke holdes lenge).
		for start = 1, #imports, IMPORT_BATCH do
			progress:setCaption('Importerer bilder …')
			gate(catalog, 'Synkroniser med Foto: importer bilder', function()
				for i = start, math.min(start + IMPORT_BATCH - 1, #imports) do
					local d = imports[i]
					local ok, res = LrTasks.pcall(function() return catalog:addPhoto(d.path) end)
					if ok and res then
						d.photo = res
						done.imported = done.imported + 1
					else
						problem('«' .. tostring(LrPathUtils.leafName(d.path)) .. '» kunne ikke importeres: ' .. FotoAPI.messageOf(res))
					end
				end
			end)
		end
	end

	-- 5. Legg bildene i albumene, merket som publisert (de finnes jo allerede på nettstedet).
	progress:setCaption('Legger bildene i albumene …')
	local toLink = 0
	for _, item in ipairs(plan.albums) do
		toLink = toLink + #(item.links or {})
		for _, d in ipairs(item.downloads or {}) do if d.photo then toLink = toLink + 1 end end
	end
	if toLink > 0 then gate(catalog, 'Synkroniser med Foto: bilder', function()
		for _, item in ipairs(plan.albums) do
			local obj = item.target.entry and item.target.entry.obj or (item.target.create and item.target.create.obj)
			if obj then
				local byId = {}
				for _, l in ipairs(item.links or {}) do byId[l.id] = l end
				for _, d in ipairs(item.downloads or {}) do
					if d.photo then byId[d.id] = { id = d.id, info = d.info, photo = d.photo } end
				end
				-- I samme rekkefølge som på nettstedet.
				for _, id in ipairs(item.node.photoIds or {}) do
					local l = byId[id]
					if l then
						local ok = tryDo('Et bilde kunne ikke legges i «' .. item.node.name .. '»', function()
							obj:addPhotoByRemoteId(l.photo, l.id, l.info.url, true)
						end)
						if ok then done.linked = done.linked + 1 end
					end
				end
			end
		end
	end) end

	-- 6. Fjern det som er slettet på nettstedet (bare når det er valgt).
	if opts.remove and stats.removedPhotos + #plan.deletedAlbums + #plan.deletedSets > 0 then
		gate(catalog, 'Synkroniser med Foto: fjern slettet', function()
			for _, item in ipairs(plan.albums) do
				local entry = item.target.entry
				if entry and #item.removed > 0 and not entry.smart then
					local ok = tryDo('Bilder kunne ikke fjernes fra «' .. entry.name .. '»', function()
						entry.obj:removePhotos(item.removed)
					end)
					if ok then done.removedPhotos = done.removedPhotos + #item.removed end
				end
			end
			for _, e in ipairs(plan.deletedAlbums) do
				if tryDo('«' .. e.name .. '» kunne ikke fjernes', function() e.obj:delete() end) then
					done.deletedAlbums = done.deletedAlbums + 1
				end
			end
			for _, e in ipairs(plan.deletedSets) do
				if tryDo('«' .. e.name .. '» kunne ikke fjernes', function() e.obj:delete() end) then
					done.deletedSets = done.deletedSets + 1
				end
			end
		end)
	end
	progress:done()

	-- Oppsummering.
	local lines = {}
	local made = {}
	if done.created.folder > 0 then made[#made + 1] = plural(done.created.folder, 'ny mappe', 'nye mapper') end
	if done.created.album > 0 then made[#made + 1] = plural(done.created.album, 'nytt album', 'nye album') end
	if #made > 0 then lines[#lines + 1] = 'Laget i Lightroom: ' .. joinAnd(made) .. '.' end
	local merged = 0
	for _, l in ipairs(plan.links) do
		if plan.targets[l.node.id] and plan.targets[l.node.id].merged then merged = merged + 1 end
	end
	if merged > 0 then
		lines[#lines + 1] = plural(merged, 'mappe eller album', 'mapper og album') .. ' med samme navn fantes allerede i Lightroom og ble koblet til nettstedet.'
	end
	local changed = {}
	if done.renamed > 0 then changed[#changed + 1] = plural(done.renamed, 'nytt navn', 'nye navn') end
	if done.moved > 0 then changed[#changed + 1] = plural(done.moved, 'flyttet', 'flyttet') end
	if done.settings > 0 then changed[#changed + 1] = plural(done.settings, 'ny innstilling', 'nye innstillinger') end
	if #changed > 0 then lines[#lines + 1] = 'Oppdatert fra nettstedet: ' .. joinAnd(changed) .. '.' end
	if done.linked > 0 then
		local how = {}
		if stats.matched > 0 then how[#how + 1] = plural(stats.matched, 'fantes', 'fantes') .. ' i katalogen' end
		if done.imported > 0 then how[#how + 1] = plural(done.imported, 'ble lastet ned og importert', 'ble lastet ned og importert') end
		lines[#lines + 1] = plural(done.linked, 'bilde', 'bilder') .. ' fra nettstedet ligger nå i albumene'
			.. (#how > 0 and (' (' .. joinAnd(how) .. ')') or '') .. '.'
	end
	if done.imported > 0 then lines[#lines + 1] = 'De nedlastede bildene ligger i ' .. opts.folder .. '.' end
	if stats.downloads > 0 and not opts.download then
		lines[#lines + 1] = plural(stats.downloads, 'bilde', 'bilder') .. ' som bare finnes på nettstedet, ble ikke lastet ned.'
	end
	if done.removedPhotos + done.deletedAlbums + done.deletedSets > 0 then
		lines[#lines + 1] = 'Fjernet fra Lightroom: ' .. removalText {
			deletedAlbums = done.deletedAlbums, deletedSets = done.deletedSets, removedPhotos = done.removedPhotos,
		} .. '.'
	end
	if #problems > 0 then
		local shown = {}
		for i = 1, math.min(#problems, 8) do shown[i] = '–  ' .. problems[i] end
		if #problems > 8 then shown[#shown + 1] = '… og ' .. (#problems - 8) .. ' til. Se loggen (Fil → Behandle tilleggsprogrammer → Foto).' end
		lines[#lines + 1] = 'Dette gikk ikke:\n' .. table.concat(shown, '\n')
	end
	lines[#lines + 1] = 'Det du legger til i albumene i Lightroom, lastes opp når du trykker «Publiser».'
	Log.info('Synkroniser ferdig:', done.created.folder, 'mapper,', done.created.album, 'album,', done.renamed, 'navn,', done.moved,
		'flyttet,', done.settings, 'innstillinger,', done.linked, 'bilder koblet,', done.downloaded, 'lastet ned,', done.imported,
		'importert,', #problems, 'problemer')
	LrDialogs.message(#problems > 0 and 'Synkronisert, med noen unntak' or 'Synkronisert med Foto', table.concat(lines, '\n\n'),
		#problems > 0 and 'warning' or 'info')
end

return Sync
