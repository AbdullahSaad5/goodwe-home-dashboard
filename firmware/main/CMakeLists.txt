idf_component_register(
  SRCS "main.cpp"
  INCLUDE_DIRS "."
  REQUIRES esp_wifi esp_event esp_netif nvs_flash esp_http_client mbedtls littlefs gwr1 goodwe_protocol
)

littlefs_create_partition_image(archive ../archive_seed FLASH_IN_PROJECT)
