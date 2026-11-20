import { createTheme } from "@mui/material/styles";

// Material Design 3 feel with an open component library: rounded surface cards,
// pill buttons, Roboto. No Google logos, product names or Google Sans (plan.md section 12).
export const theme = createTheme({
  palette: {
    primary: { main: "#386a20" },
    secondary: { main: "#55624c" },
    background: { default: "#f8faf0", paper: "#ffffff" },
  },
  shape: { borderRadius: 16 },
  typography: { fontFamily: "Roboto, system-ui, sans-serif" },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 999, textTransform: "none", minHeight: 44, paddingInline: 24 },
      },
    },
    MuiCard: { defaultProps: { variant: "outlined" } },
  },
});
