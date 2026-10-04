package kr.kimmi.mingyeol.chzzkapi;

import ch.njol.skript.variables.Variables;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** Bridges Minecraft/Skript to the separately deployed, read-only CHZZK service. */
public final class MingyeolChzzkApiPlugin extends JavaPlugin implements Listener {
    private static final String CHANNEL_ID_VARIABLE = "chzzk_channel_id::";
    private static final String CHANNEL_NAME_VARIABLE = "chzzk_channel_name::";
    private static final String LINKED_VARIABLE = "chzzk_linked::";
    // Prevents a deliberately removed DB link from being re-imported from an old local variables.sk.
    private static final String SHARED_MIGRATED_VARIABLE = "chzzk_shared_migrated::";
    private static final String SUBSCRIBER_VARIABLE = "chzzk_subscriber::";
    private static final String SUBSCRIBER_TIER_VARIABLE = "chzzk_subscriber_tier::";
    private static final String SUBSCRIBER_MONTHS_VARIABLE = "chzzk_subscriber_months::";
    private static final String FOLLOWER_VARIABLE = "chzzk_follower::";
    private static final String STATUS_UPDATED_VARIABLE = "chzzk_status_updated_at::";
    private static final List<String> OWNER_RESOURCES = List.of("channel", "managers", "followers", "subscribers", "live-settings", "chat-settings", "restrictions");
    private static final ObjectMapper JSON = new ObjectMapper();

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final Map<UUID, Instant> pendingLinks = new ConcurrentHashMap<>();
    private URI serviceBaseUrl;
    private String serviceSharedSecret;
    private int linkExpirySeconds;
    private int statusRefreshSeconds;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        serviceSharedSecret = getConfig().getString("service-shared-secret", "").trim();
        linkExpirySeconds = Math.max(60, getConfig().getInt("link-expiry-seconds", 300));
        statusRefreshSeconds = Math.max(30, getConfig().getInt("status-refresh-seconds", 300));
        try {
            String configuredUrl = getConfig().getString("service-base-url", "").trim().replaceAll("/+$", "");
            serviceBaseUrl = URI.create(configuredUrl);
        } catch (IllegalArgumentException exception) {
            getLogger().severe("config.yml의 service-base-url이 올바른 URL이 아닙니다.");
        }
        ChzzkSkriptEffects.register(this);
        ChzzkSkriptExpressions.register();
        Bukkit.getPluginManager().registerEvents(this, this);
        if (!isReady()) {
            getLogger().warning("CHZZK OAuth 서비스 주소와 service-shared-secret을 설정해야 치지직 연동을 사용할 수 있습니다.");
            return;
        }
        long periodTicks = statusRefreshSeconds * 20L;
        Bukkit.getScheduler().runTaskTimerAsynchronously(this, this::refreshOnlineStatuses, periodTicks, periodTicks);
    }

    /** Restores a globally linked CHZZK account when the player enters any connected server. */
    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        UUID uuid = event.getPlayer().getUniqueId();
        Bukkit.getScheduler().runTaskLaterAsynchronously(this, () -> synchronizeLink(uuid), 20L);
    }

    @Override
    public void onDisable() {
        pendingLinks.clear();
    }

    /** Starts the browser OAuth flow used by {@code chzzk_link}. */
    public void beginLink(Player player) {
        if (!isReady()) {
            player.sendMessage(color("&cCHZZK 연동 서비스가 설정되지 않았습니다. 관리자에게 설정을 요청하세요."));
            return;
        }
        UUID minecraftUuid = player.getUniqueId();
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            try {
                JsonNode result = request("POST", "/v1/links", "{\"minecraftUuid\":\"" + minecraftUuid + "\"}");
                String authorizationUrl = requiredText(result, "authorizationUrl");
                pendingLinks.put(minecraftUuid, Instant.now().plusSeconds(linkExpirySeconds));
                Bukkit.getScheduler().runTask(this, () -> {
                    Component linkButton = Component.text("[여기]")
                            .color(NamedTextColor.AQUA)
                            .clickEvent(ClickEvent.openUrl(authorizationUrl))
                            .hoverEvent(HoverEvent.showText(Component.text("클릭해서 치지직 계정 인증", NamedTextColor.GRAY)));
                    Component instructionLine = linkButton
                            .append(Component.text(" 를 눌러 치지직 계정 인증을 완료하세요.", NamedTextColor.GREEN));

                    // A normal space-only component may be collapsed by the client.
                    // NBSP is visually blank but reliably reserves one chat line.
                    player.sendMessage(Component.text("\u00A0"));
                    player.sendMessage(instructionLine);
                    player.sendMessage(Component.text("링크는 " + linkExpirySeconds + "초 뒤 만료됩니다.", NamedTextColor.YELLOW));
                    player.sendMessage(Component.text("\u00A0"));
                    Bukkit.getScheduler().runTaskLaterAsynchronously(this, () -> checkPendingLink(minecraftUuid), 40L);
                });
            } catch (Exception exception) {
                getLogger().warning("치지직 연동 링크 생성 실패: " + exception.getMessage());
                sendMain(player, "&c치지직 연동 링크를 만들지 못했습니다. 잠시 후 다시 시도하세요.");
            }
        });
    }

    /** Updates linked player's subscriber/follower state without exposing OAuth tokens to Skript. */
    public void refreshViewerStatus(Player player) {
        if (!isReady()) return;
        UUID uuid = player.getUniqueId();
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            try {
                JsonNode result = request("GET", "/v1/viewers/" + uuid + "/status", null);
                Bukkit.getScheduler().runTask(this, () -> storeViewerStatus(uuid, result));
            } catch (Exception exception) {
                getLogger().fine("치지직 상태 조회 실패 (" + player.getName() + "): " + exception.getMessage());
            }
        });
    }

    /** Reads every allowed broadcaster endpoint and writes the result into Skript variables. */
    public void refreshOwnerReadData() {
        if (!isReady()) return;
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            for (String resource : OWNER_RESOURCES) {
                try {
                    JsonNode result = request("GET", "/v1/owner/read/" + resource + "?page=0&size=50", null);
                    Bukkit.getScheduler().runTask(this, () -> storeOwnerReadData(resource, result));
                } catch (Exception exception) {
                    getLogger().warning("치지직 " + resource + " 조회 실패: " + exception.getMessage());
                }
            }
        });
    }

    private void synchronizeLink(UUID minecraftUuid) {
        if (!isReady()) return;
        try {
            JsonNode result = request("GET", "/v1/links/" + minecraftUuid, null);
            Bukkit.getScheduler().runTask(this, () -> {
                if (!result.path("linked").asBoolean(false)) {
                    migrateLegacyViewerLink(minecraftUuid);
                    return;
                }
                String channelId = result.path("channelId").asText("").trim();
                String channelName = result.path("channelName").asText("").trim();
                if (channelId.isEmpty() || channelName.isEmpty()) return;
                storeViewerLink(minecraftUuid, channelId, channelName);
                Variables.setVariable(SHARED_MIGRATED_VARIABLE + minecraftUuid, true, null, false);
                Player player = Bukkit.getPlayer(minecraftUuid);
                if (player != null) refreshViewerStatus(player);
            });
        } catch (Exception exception) {
            getLogger().warning("공용 치지직 연동 정보 동기화 실패 (" + minecraftUuid + "): " + exception.getMessage());
        }
    }

    /**
     * Imports the old per-server Skript values once, when their owner first joins a server
     * using this plugin.  The API server cannot safely read another Minecraft server's
     * variables.sk directly, so this keeps the migration authenticated by the plugin secret.
     */
    private void migrateLegacyViewerLink(UUID minecraftUuid) {
        if (Boolean.TRUE.equals(Variables.getVariable(SHARED_MIGRATED_VARIABLE + minecraftUuid, null, false))) {
            clearViewerLink(minecraftUuid);
            return;
        }

        String channelId = variableText(CHANNEL_ID_VARIABLE + minecraftUuid);
        if (channelId.isEmpty()) {
            clearViewerLink(minecraftUuid);
            return;
        }
        String channelName = variableText(CHANNEL_NAME_VARIABLE + minecraftUuid);
        if (channelName.isEmpty()) channelName = "알 수 없음";

        final String legacyChannelId = channelId;
        final String legacyChannelName = channelName;
        Bukkit.getScheduler().runTaskAsynchronously(this, () -> {
            try {
                String body = JSON.writeValueAsString(Map.of(
                        "channelId", legacyChannelId,
                        "channelName", legacyChannelName
                ));
                JsonNode result = request("PUT", "/v1/links/" + minecraftUuid, body);
                String storedChannelId = requiredText(result, "channelId");
                String storedChannelName = requiredText(result, "channelName");
                Bukkit.getScheduler().runTask(this, () -> {
                    storeViewerLink(minecraftUuid, storedChannelId, storedChannelName);
                    Variables.setVariable(SHARED_MIGRATED_VARIABLE + minecraftUuid, true, null, false);
                    getLogger().info("기존 Skript 치지직 연동 정보를 공용 DB로 이전했습니다: " + minecraftUuid);
                    Player player = Bukkit.getPlayer(minecraftUuid);
                    if (player != null) refreshViewerStatus(player);
                });
            } catch (Exception exception) {
                String message = exception.getMessage() == null ? "" : exception.getMessage();
                if (message.contains("CHZZK_ALREADY_LINKED")) {
                    Bukkit.getScheduler().runTask(this, () -> {
                        clearViewerLink(minecraftUuid);
                        Variables.setVariable(SHARED_MIGRATED_VARIABLE + minecraftUuid, true, null, false);
                        getLogger().warning("기존 Skript 치지직 ID를 이전하지 않았습니다. 이미 다른 계정에 연결되어 있습니다: " + minecraftUuid);
                    });
                    return;
                }
                getLogger().warning("기존 Skript 치지직 연동 정보 이전 실패 (다음 접속에 다시 시도): " + minecraftUuid + ": " + message);
            }
        });
    }

    private void refreshOnlineStatuses() {
        for (Player player : Bukkit.getOnlinePlayers()) {
            Object linked = Variables.getVariable(LINKED_VARIABLE + player.getUniqueId(), null, false);
            if (Boolean.TRUE.equals(linked)) refreshViewerStatus(player);
        }
    }

    private void checkPendingLink(UUID minecraftUuid) {
        Instant expiresAt = pendingLinks.get(minecraftUuid);
        if (expiresAt == null) return;
        try {
            JsonNode result = request("GET", "/v1/links/" + minecraftUuid, null);
            if (!result.path("linked").asBoolean(false)) {
                if (Instant.now().isBefore(expiresAt)) {
                    Bukkit.getScheduler().runTaskLaterAsynchronously(this, () -> checkPendingLink(minecraftUuid), 40L);
                } else {
                    pendingLinks.remove(minecraftUuid);
                    Player player = Bukkit.getPlayer(minecraftUuid);
                    if (player != null) sendMain(player, "&e치지직 연동 시간이 만료되었습니다. `/연동 치지직`을 다시 실행하세요.");
                }
                return;
            }
            String channelId = requiredText(result, "channelId");
            String channelName = requiredText(result, "channelName");
            pendingLinks.remove(minecraftUuid);
            Bukkit.getScheduler().runTask(this, () -> {
                storeViewerLink(minecraftUuid, channelId, channelName);
                Player player = Bukkit.getPlayer(minecraftUuid);
                if (player != null) {
                    player.sendMessage(color("&a치지직 계정 &f" + channelName + "&a 연동이 완료되었습니다."));
                    refreshViewerStatus(player);
                }
            });
        } catch (Exception exception) {
            getLogger().warning("치지직 연동 상태 확인 실패: " + exception.getMessage());
            Player player = Bukkit.getPlayer(minecraftUuid);
            if (player != null) sendMain(player, "&c치지직 연동 상태를 확인하지 못했습니다.");
        }
    }

    private void storeViewerLink(UUID minecraftUuid, String channelId, String channelName) {
        Variables.setVariable(CHANNEL_ID_VARIABLE + minecraftUuid, channelId, null, false);
        Variables.setVariable(CHANNEL_NAME_VARIABLE + minecraftUuid, channelName, null, false);
        Variables.setVariable(LINKED_VARIABLE + minecraftUuid, true, null, false);
    }

    private String variableText(String variable) {
        Object value = Variables.getVariable(variable, null, false);
        return value instanceof String text ? text.trim() : "";
    }

    private void clearViewerLink(UUID minecraftUuid) {
        Variables.deleteVariable(CHANNEL_ID_VARIABLE + minecraftUuid, null, false);
        Variables.deleteVariable(CHANNEL_NAME_VARIABLE + minecraftUuid, null, false);
        Variables.setVariable(LINKED_VARIABLE + minecraftUuid, false, null, false);
        Variables.setVariable(SUBSCRIBER_VARIABLE + minecraftUuid, false, null, false);
        Variables.setVariable(FOLLOWER_VARIABLE + minecraftUuid, false, null, false);
        Variables.deleteVariable(SUBSCRIBER_TIER_VARIABLE + minecraftUuid, null, false);
        Variables.deleteVariable(SUBSCRIBER_MONTHS_VARIABLE + minecraftUuid, null, false);
    }

    private void storeViewerStatus(UUID uuid, JsonNode result) {
        boolean linked = result.path("linked").asBoolean(false);
        Variables.setVariable(LINKED_VARIABLE + uuid, linked, null, false);
        if (!linked) {
            Variables.setVariable(SUBSCRIBER_VARIABLE + uuid, false, null, false);
            Variables.setVariable(FOLLOWER_VARIABLE + uuid, false, null, false);
            return;
        }
        setIfText(CHANNEL_ID_VARIABLE + uuid, result.path("channelId").asText());
        setIfText(CHANNEL_NAME_VARIABLE + uuid, result.path("channelName").asText());
        Variables.setVariable(SUBSCRIBER_VARIABLE + uuid, result.path("subscriber").asBoolean(false), null, false);
        Variables.setVariable(FOLLOWER_VARIABLE + uuid, result.path("following").asBoolean(false), null, false);
        if (result.hasNonNull("subscriberTier")) Variables.setVariable(SUBSCRIBER_TIER_VARIABLE + uuid, result.path("subscriberTier").asText(), null, false);
        else Variables.deleteVariable(SUBSCRIBER_TIER_VARIABLE + uuid, null, false);
        if (result.hasNonNull("subscriberMonths")) Variables.setVariable(SUBSCRIBER_MONTHS_VARIABLE + uuid, result.path("subscriberMonths").asInt(), null, false);
        else Variables.deleteVariable(SUBSCRIBER_MONTHS_VARIABLE + uuid, null, false);
        Variables.setVariable(STATUS_UPDATED_VARIABLE + uuid, Instant.now().toString(), null, false);
    }

    private void storeOwnerReadData(String resource, JsonNode result) {
        String prefix = "chzzk_read::" + resource;
        Variables.deleteVariable(prefix + "::*", null, false);
        Variables.setVariable(prefix + "::updated_at", Instant.now().toString(), null, false);
        Variables.setVariable(prefix + "::channel_id", result.path("channelId").asText(), null, false);
        Variables.setVariable(prefix + "::channel_name", result.path("channelName").asText(), null, false);
        JsonNode data = result.path("data");
        Variables.setVariable("chzzk_read_json::" + resource, data.toString(), null, false);
        flattenJson(prefix + "::data", data, 0);
    }

    private void flattenJson(String prefix, JsonNode node, int depth) {
        if (depth > 10 || node == null || node.isMissingNode() || node.isNull()) return;
        if (node.isObject()) {
            node.fields().forEachRemaining(field -> flattenJson(prefix + "::" + safeVariablePart(field.getKey()), field.getValue(), depth + 1));
        } else if (node.isArray()) {
            for (int index = 0; index < node.size(); index++) flattenJson(prefix + "::" + (index + 1), node.get(index), depth + 1);
        } else if (node.isBoolean()) {
            Variables.setVariable(prefix, node.booleanValue(), null, false);
        } else if (node.isIntegralNumber()) {
            Variables.setVariable(prefix, node.longValue(), null, false);
        } else if (node.isFloatingPointNumber()) {
            Variables.setVariable(prefix, node.doubleValue(), null, false);
        } else {
            Variables.setVariable(prefix, node.asText(), null, false);
        }
    }

    private String safeVariablePart(String key) {
        return key.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private void setIfText(String variable, String value) {
        if (value != null && !value.isBlank()) Variables.setVariable(variable, value, null, false);
    }

    private JsonNode request(String method, String path, String body) throws IOException, InterruptedException {
        HttpRequest.Builder builder = HttpRequest.newBuilder(serviceBaseUrl.resolve(path))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + serviceSharedSecret)
                .header("Content-Type", "application/json");
        if (method.equals("POST")) builder.POST(HttpRequest.BodyPublishers.ofString(body));
        else if (method.equals("PUT")) builder.PUT(HttpRequest.BodyPublishers.ofString(body));
        else builder.GET();
        HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        JsonNode json = JSON.readTree(response.body());
        if (response.statusCode() / 100 != 2) throw new IOException(json.path("error").asText("HTTP " + response.statusCode()));
        return json;
    }

    private String requiredText(JsonNode node, String field) throws IOException {
        String value = node.path(field).asText("").trim();
        if (value.isEmpty()) throw new IOException("응답에 " + field + " 값이 없습니다.");
        return value;
    }

    private boolean isReady() {
        return serviceBaseUrl != null && (serviceBaseUrl.getScheme().equals("https") || serviceBaseUrl.getScheme().equals("http"))
                && !serviceSharedSecret.isBlank() && !serviceSharedSecret.equals("PUT_A_LONG_RANDOM_SHARED_SECRET_HERE");
    }

    private void sendMain(Player player, String message) { Bukkit.getScheduler().runTask(this, () -> player.sendMessage(color(message))); }
    private String color(String message) { return ChatColor.translateAlternateColorCodes('&', message); }
}
