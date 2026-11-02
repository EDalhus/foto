--[[
	Liten JSON-modul (Lua 5.1), siden Lightroom ikke har en innebygd.
	JSON.encode(verdi) -> streng, JSON.decode(streng) -> verdi.
	Tabeller med sammenhengende heltallsnøkler 1..n blir lister, andre blir objekter.
	JSON.null kan brukes for å sende eksplisitt null.
]]

local JSON = {}
JSON.null = setmetatable({}, { __tostring = function() return 'null' end })

-- Koding ----------------------------------------------------------------------

local escapes = {
	['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f',
	['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encodeString(s)
	return '"' .. s:gsub('[%c"\\]', function(c)
		return escapes[c] or string.format('\\u%04x', c:byte())
	end) .. '"'
end

local function isArray(t)
	local n = 0
	for k in pairs(t) do
		if type(k) ~= 'number' or k < 1 or math.floor(k) ~= k then return false end
		n = n + 1
	end
	for i = 1, n do
		if t[i] == nil then return false end
	end
	return true, n
end

local encodeValue

local function encodeTable(t, seen)
	if seen[t] then error('JSON: syklisk tabell') end
	seen[t] = true
	local out = {}
	local array, n = isArray(t)
	if array and n > 0 then
		for i = 1, n do out[#out + 1] = encodeValue(t[i], seen) end
		seen[t] = nil
		return '[' .. table.concat(out, ',') .. ']'
	end
	if array and n == 0 and getmetatable(t) == JSON.arrayMeta then
		seen[t] = nil
		return '[]'
	end
	local keys = {}
	for k in pairs(t) do keys[#keys + 1] = tostring(k) end
	table.sort(keys)
	for _, k in ipairs(keys) do
		local v = t[k]
		if v == nil then v = t[tonumber(k)] end
		if v ~= nil then out[#out + 1] = encodeString(k) .. ':' .. encodeValue(v, seen) end
	end
	seen[t] = nil
	return '{' .. table.concat(out, ',') .. '}'
end

encodeValue = function(v, seen)
	local t = type(v)
	if v == nil or v == JSON.null then return 'null'
	elseif t == 'boolean' then return v and 'true' or 'false'
	elseif t == 'number' then
		if v ~= v or v == math.huge or v == -math.huge then return 'null' end
		if math.floor(v) == v and math.abs(v) < 1e15 then return string.format('%d', v) end
		return string.format('%.14g', v)
	elseif t == 'string' then return encodeString(v)
	elseif t == 'table' then return encodeTable(v, seen)
	end
	error('JSON: kan ikke kode ' .. t)
end

--- Tom liste som skal kodes som [] og ikke {}.
JSON.arrayMeta = {}
function JSON.array(t) return setmetatable(t or {}, JSON.arrayMeta) end

function JSON.encode(v)
	return encodeValue(v, {})
end

-- Dekoding --------------------------------------------------------------------

local function codepointToUtf8(n)
	if n < 0x80 then return string.char(n)
	elseif n < 0x800 then
		return string.char(0xC0 + math.floor(n / 0x40), 0x80 + n % 0x40)
	elseif n < 0x10000 then
		return string.char(0xE0 + math.floor(n / 0x1000), 0x80 + math.floor(n / 0x40) % 0x40, 0x80 + n % 0x40)
	end
	return string.char(0xF0 + math.floor(n / 0x40000), 0x80 + math.floor(n / 0x1000) % 0x40,
		0x80 + math.floor(n / 0x40) % 0x40, 0x80 + n % 0x40)
end

local function decodeError(str, pos, msg)
	error(string.format('JSON: %s ved posisjon %d', msg, pos), 0)
end

local function skip(str, pos)
	return str:find('[^ \t\r\n]', pos) or (#str + 1)
end

local decodeValue

local function decodeString(str, pos)
	local out = {}
	local i = pos + 1
	while true do
		local c = str:sub(i, i)
		if c == '' then decodeError(str, i, 'uavsluttet streng') end
		if c == '"' then return table.concat(out), i + 1 end
		if c == '\\' then
			local e = str:sub(i + 1, i + 1)
			local simple = ({ ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' })[e]
			if simple then
				out[#out + 1] = simple
				i = i + 2
			elseif e == 'u' then
				local hex = str:sub(i + 2, i + 5)
				local n = tonumber(hex, 16)
				if not n then decodeError(str, i, 'ugyldig \\u') end
				i = i + 6
				if n >= 0xD800 and n <= 0xDBFF and str:sub(i, i + 1) == '\\u' then
					local low = tonumber(str:sub(i + 2, i + 5), 16)
					if low and low >= 0xDC00 and low <= 0xDFFF then
						n = 0x10000 + (n - 0xD800) * 0x400 + (low - 0xDC00)
						i = i + 6
					end
				end
				out[#out + 1] = codepointToUtf8(n)
			else
				decodeError(str, i, 'ugyldig escape')
			end
		else
			local j = str:find('["\\]', i)
			if not j then decodeError(str, i, 'uavsluttet streng') end
			out[#out + 1] = str:sub(i, j - 1)
			i = j
		end
	end
end

local function decodeNumber(str, pos)
	local num = str:match('^-?%d+%.?%d*[eE]?[-+]?%d*', pos)
	local n = num and tonumber(num)
	if not n then decodeError(str, pos, 'ugyldig tall') end
	return n, pos + #num
end

local function decodeArray(str, pos)
	local out = {}
	pos = skip(str, pos + 1)
	if str:sub(pos, pos) == ']' then return out, pos + 1 end
	while true do
		local v
		v, pos = decodeValue(str, pos)
		out[#out + 1] = v
		pos = skip(str, pos)
		local c = str:sub(pos, pos)
		if c == ']' then return out, pos + 1 end
		if c ~= ',' then decodeError(str, pos, 'forventet , eller ]') end
		pos = skip(str, pos + 1)
	end
end

local function decodeObject(str, pos)
	local out = {}
	pos = skip(str, pos + 1)
	if str:sub(pos, pos) == '}' then return out, pos + 1 end
	while true do
		if str:sub(pos, pos) ~= '"' then decodeError(str, pos, 'forventet nøkkel') end
		local k
		k, pos = decodeString(str, pos)
		pos = skip(str, pos)
		if str:sub(pos, pos) ~= ':' then decodeError(str, pos, 'forventet :') end
		local v
		v, pos = decodeValue(str, skip(str, pos + 1))
		out[k] = v
		pos = skip(str, pos)
		local c = str:sub(pos, pos)
		if c == '}' then return out, pos + 1 end
		if c ~= ',' then decodeError(str, pos, 'forventet , eller }') end
		pos = skip(str, pos + 1)
	end
end

decodeValue = function(str, pos)
	pos = skip(str, pos)
	local c = str:sub(pos, pos)
	if c == '{' then return decodeObject(str, pos)
	elseif c == '[' then return decodeArray(str, pos)
	elseif c == '"' then return decodeString(str, pos)
	elseif c == '-' or c:match('%d') then return decodeNumber(str, pos)
	elseif str:sub(pos, pos + 3) == 'true' then return true, pos + 4
	elseif str:sub(pos, pos + 4) == 'false' then return false, pos + 5
	elseif str:sub(pos, pos + 3) == 'null' then return nil, pos + 4
	end
	decodeError(str, pos, 'uventet tegn')
end

function JSON.decode(str)
	if type(str) ~= 'string' then error('JSON: forventet streng', 0) end
	local v, pos = decodeValue(str, 1)
	pos = skip(str, pos)
	if pos <= #str then decodeError(str, pos, 'overflødige tegn') end
	return v
end

return JSON
